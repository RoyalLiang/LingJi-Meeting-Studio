#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod audio;
#[cfg(feature = "smoke-test")] mod native_evolution_probe;
#[cfg(feature = "smoke-test")] static NATIVE_EVOLUTION_PROBE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
mod meeting_watch;
mod config;
mod integration_links;
mod downloads;
mod local_backend;
mod menu_status;
mod proxy;
mod resident;
mod recording_widget;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
mod status_bar;
mod update_gate;
mod updates;
mod preview_updates;
use std::sync::Arc;
use tauri::{
    ipc::{CapabilityBuilder, Response},
    Emitter, Manager, State, WebviewUrl, WebviewWindow,
};

#[cfg(target_os = "windows")]
const RECORDING_BROWSER_ARGS: &str = "--disable-background-timer-throttling";

struct Client {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    menu_bar: status_bar::StatusBar,
    origin: String,
    #[cfg(target_os = "macos")]
    store_id: [u8; 16],
    #[cfg(not(target_os = "macos"))]
    profile: std::path::PathBuf,
    captures: Arc<audio::Captures>,
    resident: resident::Resident,
    _lock: std::fs::File,
    _backend: Option<local_backend::LocalBackend>,
    updates: updates::Updates,
    api: proxy::Proxy,
}

fn authorize(window: &WebviewWindow, state: &Client) -> Result<(), String> {
    if window.label() != "main"
        || window
            .url()
            .map_err(|e| e.to_string())?
            .origin()
            .ascii_serialization()
            != state.origin
    {
        return Err("客户端权限被拒绝".into());
    }
    Ok(())
}

#[tauri::command]
fn client_attention(window: WebviewWindow, state: State<'_, Client>) -> Result<(), String> {
    authorize(&window, &state)?;
    window.request_user_attention(Some(tauri::UserAttentionType::Informational)).map_err(|_| "无法请求用户关注".into())
}

#[tauri::command]
async fn audio_backup_directory(window: WebviewWindow, state: State<'_, Client>, initial: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    authorize(&window, &state)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app.dialog().file().set_parent(&window).set_title("选择原始音频备份目录");
        if let Some(path) = initial.filter(|path| std::path::Path::new(path).is_dir()) {
            picker = picker.set_directory(path);
        }
        picker.blocking_pick_folder().map(|path| path.into_path().map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.to_string())).transpose()
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn integration_open(window: WebviewWindow, state: State<'_, Client>, url: String) -> Result<(), String> {
    authorize(&window, &state)?;
    integration_links::open(&url)
}

#[tauri::command]
fn meeting_watch_configure(window: WebviewWindow, state: State<'_, Client>, watch: State<'_, meeting_watch::MeetingWatch>, enabled: bool, browser: bool, feishu: bool, token: String) -> Result<bool, String> {
    authorize(&window, &state)?;
    watch.configure(window.app_handle().clone(),enabled,browser,feishu,token)
}

#[tauri::command]
async fn capture_start(
    window: WebviewWindow,
    state: State<'_, Client>,
    kind: String,
    device_id: Option<String>,
) -> Result<audio::Started, String> {
    authorize(&window, &state)?;
    let _permission = state.updates.gate.capture()?;
    if !["display", "microphone"].contains(&kind.as_str()) {
        return Err("未知音源".into());
    }
    #[cfg(feature = "smoke-test")]
    if std::env::var("TTS_CLIENT_SYNTHETIC").as_deref() == Ok("1") {
        return state.captures.synthetic(&kind);
    }
    // The explicit source action reaches the OS permission check directly.
    // CoreAudio retains its own grants; do not add a recurring app confirmation
    // or treat a local acknowledgement as proof that OS access is still allowed.
    let captures = state.captures.clone();
    tauri::async_runtime::spawn_blocking(move || captures.start(&kind, device_id.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn capture_direct_start(window: WebviewWindow, state: tauri::State<'_, Client>, record_id: String, kind: String, device_id: Option<String>) -> Result<serde_json::Value, String> {
    authorize(&window, &state)?;
    let _permission = state.updates.gate.capture()?;
    let backend = state._backend.as_ref().ok_or("本机音频后台未启用")?;
    let mut identity = [0u8; 16]; getrandom::fill(&mut identity).map_err(|_| "录音连接标识不可用")?;
    let hex: String = identity.iter().map(|byte| format!("{byte:02x}")).collect();
    let request_id = format!("{}-{}-{}-{}-{}", &hex[..8],&hex[8..12],&hex[12..16],&hex[16..20],&hex[20..]);
    let captures = state.captures.clone(); let source_kind = kind.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(feature = "smoke-test")]
        if std::env::var("TTS_CLIENT_SYNTHETIC").as_deref() == Ok("1") { return captures.prepare_synthetic(&source_kind); }
        captures.prepare(&source_kind, device_id.as_deref())
    }).await.map_err(|error| error.to_string())??;
    let binding = state.api.native_bind(&backend.native_instance, serde_json::json!({"recordId":record_id,"requestId":request_id,"kind":kind,"label":started.label.chars().take(80).collect::<String>(),"timelineOffsetMs":state.captures.direct_timeline(&record_id)})).await;
    let mut binding = match binding { Ok(value) => value, Err(error) => { state.captures.abandon_prepared(&started.id); let _ = state.api.native_bind(&backend.native_instance, serde_json::json!({"action":"cancel","requestId":request_id,"recordId":record_id})).await; return Err(error); } };
    binding["recordId"] = serde_json::Value::String(record_id);
    if let Err(error) = state.captures.bind_direct(&started.id, &backend.native_root, binding.clone()) {
        state.captures.abandon_prepared(&started.id);
        let _ = state.api.native_bind(&backend.native_instance, serde_json::json!({"action":"cancel","leaseId":binding["leaseId"]})).await;
        return Err(error);
    }
    if let Err(error) = recording_widget::prepare(window.app_handle(), &state) { eprintln!("[recording-widget] {error}"); }
    recording_widget::native_heartbeat(window.app_handle());
    Ok(serde_json::json!({"id":started.id,"label":started.label,"source":binding["source"]}))
}
#[tauri::command]
fn capture_direct_kind(window: WebviewWindow, state: tauri::State<'_, Client>, record_id: String, kind: String, enabled: bool) -> Result<(), String> {
    authorize(&window, &state)?; state.captures.set_native_kind(&record_id,&kind,enabled)
}
#[tauri::command]
async fn capture_direct_control(window: WebviewWindow, state: tauri::State<'_, Client>, record_id: String, action: String) -> Result<(), String> {
    authorize(&window, &state)?;
    let captures = state.captures.clone(); tauri::async_runtime::spawn_blocking(move || captures.stop_record(&record_id, &action)).await.map_err(|error| error.to_string())?
}
#[tauri::command]
fn capture_direct_sessions(window: WebviewWindow, state: tauri::State<'_, Client>) -> Result<Vec<serde_json::Value>, String> {
    authorize(&window, &state)?; Ok(state.captures.direct_sessions())
}
#[tauri::command]
async fn capture_direct_progress(window: WebviewWindow, state: tauri::State<'_, Client>, id: String) -> Result<serde_json::Value, String> {
    authorize(&window, &state)?; let captures=state.captures.clone(); tauri::async_runtime::spawn_blocking(move || captures.direct_progress(&id)).await.map_err(|error|error.to_string())?
}
#[tauri::command]
async fn capture_direct_stop(window: WebviewWindow, state: tauri::State<'_, Client>, id: String, action: String) -> Result<serde_json::Value, String> {
    authorize(&window, &state)?; let captures = state.captures.clone();
    tauri::async_runtime::spawn_blocking(move || captures.stop_direct(&id, &action)).await.map_err(|error| error.to_string())?
}
#[tauri::command]
async fn capture_read(
    window: WebviewWindow,
    state: State<'_, Client>,
    id: String,
) -> Result<Response, String> {
    authorize(&window, &state)?;
    let captures = state.captures.clone();
    tauri::async_runtime::spawn_blocking(move || captures.read(&id).map(Response::new))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn capture_progress(window: WebviewWindow, state: State<'_, Client>, id: String) -> Result<audio::Progress, String> {
    authorize(&window, &state)?;
    state.captures.progress(&id)
}

#[tauri::command]
fn capture_ack(window: WebviewWindow, state: State<'_, Client>, id: String, sequence: u32, sample_offset: u32, sample_count: u32) -> Result<(), String> {
    authorize(&window, &state)?;
    state.captures.acknowledge(&id, sequence, sample_offset, sample_count)
}

#[tauri::command]
fn capture_stop(
    window: WebviewWindow,
    state: State<'_, Client>,
    id: String,
    discard: bool,
) -> Result<(), String> {
    authorize(&window, &state)?;
    state.captures.stop(&id, discard)
}

#[tauri::command]
async fn capture_applications(window:WebviewWindow,state:State<'_,Client>)->Result<audio::applications::Applications,String>{
    authorize(&window,&state)?;
    tauri::async_runtime::spawn_blocking(audio::applications::list).await.map_err(|error|error.to_string())?
}

#[tauri::command]
async fn capture_inputs(
    window: WebviewWindow,
    state: State<'_, Client>,
) -> Result<Vec<audio::Input>, String> {
    authorize(&window, &state)?;
    tauri::async_runtime::spawn_blocking(audio::inputs)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn client_status(
    window: WebviewWindow,
    state: State<'_, Client>,
    report: menu_status::Report,
    theme: Option<String>,
) -> Result<(), String> {
    authorize(&window, &state)?;
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let authenticated = report.authenticated; state.resident.authenticated(authenticated);
    let controls_ready = !report.busy && ((report.capture == "recording" && report.recording) || (report.capture == "paused" && !report.recording));
    state.menu_bar.report(report);
    if authenticated && controls_ready { state.resident.deliver_action(&window); }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let _ = report;
    let appearance = match theme.as_deref() {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        None => None,
        _ => return Err("invalid window theme".into()),
    };
    #[cfg(target_os = "macos")]
    if let Some(appearance) = appearance {
        let color = if appearance == tauri::Theme::Dark { tauri::webview::Color(36, 40, 43, 255) } else { tauri::webview::Color(246, 249, 247, 255) };
        window.set_theme(Some(appearance)).map_err(|error| error.to_string())?;
        window.set_background_color(Some(color)).map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = appearance;
    Ok(())
}

fn menu_has_pending(state: &Client) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        state.menu_bar.has_pending()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = state;
        false
    }
}

#[tauri::command]
async fn client_ready(window: WebviewWindow, state: State<'_, Client>) -> Result<(), String> {
    authorize(&window, &state)?;
    state.resident.ready();
    #[cfg(target_os="macos")]
    preview_updates::finish_handoff(window.app_handle());
    // A failed prewarm is retried before a recording can hide the main window.
    let _=recording_widget::prepare(window.app_handle(), &state);
    Ok(())
}

#[cfg(feature = "smoke-test")]
#[tauri::command]
async fn client_probe(
    window: WebviewWindow,
    state: State<'_, Client>,
    result: serde_json::Value,
) -> Result<serde_json::Value, String> {
    authorize(&window, &state)?;
    if let Some(action) = result.get("residentAction").and_then(|value| value.as_str()) {
        match action {
            "close" => window.close().map_err(|e| e.to_string())?,
            "restore" => resident::show(window.app_handle()),
            "snapshot" => {},
            _ => return Err("unknown resident probe action".into()),
        }
        return Ok(serde_json::json!({"visible":window.is_visible().map_err(|e|e.to_string())?,"nativeActive":state.captures.active()}));
    }
    if let Some(action) = result.get("widgetAction").and_then(|value| value.as_str()) {
        match action {
            "hold-ready" => window.state::<recording_widget::RecordingWidget>().hold_ready(),
            "release-ready" => recording_widget::release_held_ready(window.app_handle()).await?,
            "native-close" => window.close().map_err(|e|e.to_string())?,
            "native-minimize" => window.minimize().map_err(|e|e.to_string())?,
            "native-restore" => status_bar::show(window.app_handle()),
            _ => {},
        }
        let widget = window.app_handle().get_webview_window("recording-widget");
        if let Some(floating) = &widget {
            let selector = match action {
                "displace" => {
                    let position = floating.outer_position().map_err(|e| e.to_string())?;
                    floating.set_position(tauri::PhysicalPosition::new(position.x + 73, position.y + 41)).map_err(|e| e.to_string())?;
                    None
                },
                "snapshot" | "hold-ready" | "release-ready" | "native-restore" | "native-minimize" | "native-close" => None,
                "pause" => Some(r#".capsule-actions button[aria-label="暂停录音"], .capsule-actions button[aria-label="继续录音"]"#),
                "finish" => Some(r#".capsule-actions button[aria-label="结束并整理"]"#),
                "restore" => Some(r#".capsule-actions button[aria-label="返回主窗口"]"#),
                _ => return Err("unknown widget probe action".into()),
            };
            if let Some(selector) = selector {
                floating.eval(&format!("(()=>{{let tries=0;const click=()=>{{const button=document.querySelector({});if(button&&!button.disabled)button.click();else if(++tries<100)setTimeout(click,50);}};click();}})()", serde_json::to_string(selector).unwrap())).map_err(|e| e.to_string())?;
            }
        }
        let placement = widget.as_ref().and_then(|floating| {
            let monitor = window.current_monitor().ok()??;
            let position = floating.outer_position().ok()?;
            let size = floating.outer_size().ok()?;
            let area = monitor.work_area();
            Some(serde_json::json!({
                "topGap": (position.y - area.position.y) as f64 / monitor.scale_factor(),
                "centerOffset": (position.x as f64 + size.width as f64 / 2.0 - area.position.x as f64 - area.size.width as f64 / 2.0) / monitor.scale_factor(),
                "width": size.width as f64 / monitor.scale_factor(),
            }))
        });
        let widget_state = window.state::<recording_widget::RecordingWidget>();
        return Ok(serde_json::json!({"placement":placement,"ready":widget_state.ready(),"widgetRecording":widget_state.recording(), "widgetLogicalHeight":widget.as_ref().and_then(|w|Some(w.inner_size().ok()?.height as f64/w.scale_factor().ok()?)), "widgetDurationMs":widget_state.duration_ms(), "canResume":widget_state.can_resume(), "widgetVisible":widget.as_ref().is_some_and(|w|w.is_visible().unwrap_or(false)), "mainVisible":window.is_visible().map_err(|e|e.to_string())?, "mainMinimized":window.is_minimized().map_err(|e|e.to_string())?}));
    }
    if let Some(activity) = result.get("updateActivity") {
        state
            .updates
            .gate
            .report(serde_json::from_value(activity.clone()).map_err(|e| e.to_string())?);
        return Ok(serde_json::Value::Null);
    }
    let path =
        std::env::var("TTS_CLIENT_PROBE_OUTPUT").map_err(|_| "probe output not configured")?;
    std::fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).map_err(|e| e.to_string())?;
    if std::env::var_os("TTS_CLIENT_PROBE_AUTO_EXIT").is_some() {
        let app=window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            resident::probe_exit(&app);
        });
    }
    Ok(serde_json::Value::Null)
}

#[tauri::command]
async fn client_close(
    window: WebviewWindow,
    state: State<'_, Client>,
    force: bool,
) -> Result<(), String> {
    authorize(&window, &state)?;
    resident::confirm_quit(&window, force).await
}

#[tauri::command]
fn update_status(
    window: WebviewWindow,
    state: State<'_, Client>,
) -> Result<updates::Status, String> {
    authorize(&window, &state)?;
    Ok(state.updates.status())
}
#[tauri::command]
fn update_activity(
    window: WebviewWindow,
    state: State<'_, Client>,
    activity: update_gate::Activity,
    auto_download: Option<bool>,
) -> Result<(), String> {
    authorize(&window, &state)?;
    #[cfg(feature = "smoke-test")]
    if std::env::var_os("TTS_UPDATE_TEST_CASE").is_some() {
        return Ok(());
    }
    state.updates.gate.report(activity);
    if let Some(enabled) = auto_download {
        state.updates.set_auto_download(enabled);
    }
    Ok(())
}
#[tauri::command]
async fn update_check(
    window: WebviewWindow,
    state: State<'_, Client>,
) -> Result<updates::Status, String> {
    authorize(&window, &state)?;
    state.updates.check(window.app_handle()).await
}
#[tauri::command]
async fn update_download(
    window: WebviewWindow,
    state: State<'_, Client>,
) -> Result<updates::Status, String> {
    authorize(&window, &state)?;
    state.updates.download(window.app_handle()).await
}
#[tauri::command]
async fn update_install(window: WebviewWindow, state: State<'_, Client>) -> Result<(), String> {
    authorize(&window, &state)?;
    state
        .updates
        .install(window.app_handle(), &state.captures, &state.api)
        .await
}

fn main() {
    let builder = tauri::Builder::default();
    // Explicit profile overrides are separate development/test instances.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = if std::env::var_os("TTS_CLIENT_DATA_DIR").is_none() {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| resident::show(app)))
    } else { builder };
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(feature = "smoke-test")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        recording_widget::recording_widget_update, recording_widget::recording_widget_state, recording_widget::recording_widget_ready, recording_widget::recording_widget_action,
        integration_open,
            client_attention,
        audio_backup_directory,
        meeting_watch_configure,
        capture_start,
        capture_direct_start, capture_direct_progress, capture_direct_stop, capture_direct_sessions, capture_direct_control, capture_direct_kind,
        capture_read,
        capture_ack,
        capture_progress,
        capture_stop,
        capture_inputs,
        capture_applications,
        client_ready,
        client_status,
        update_status,
        update_activity,
        update_check,
        update_download,
        update_install,
        client_close,
        client_probe
    ]);
    #[cfg(not(feature = "smoke-test"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        recording_widget::recording_widget_update, recording_widget::recording_widget_state, recording_widget::recording_widget_ready, recording_widget::recording_widget_action,
        integration_open,
            client_attention,
        audio_backup_directory,
        meeting_watch_configure,
        capture_start,
        capture_direct_start, capture_direct_progress, capture_direct_stop, capture_direct_sessions, capture_direct_control, capture_direct_kind,
        capture_read,
        capture_ack,
        capture_progress,
        capture_stop,
        capture_inputs,
        capture_applications,
        client_ready,
        client_status,
        update_status,
        update_activity,
        update_check,
        update_download,
        update_install,
        client_close
    ]);
    builder
        .setup(|app| {
            let directory = match std::env::var("TTS_CLIENT_DATA_DIR") { Ok(path) => std::path::PathBuf::from(path), Err(_) => app.path().app_config_dir().map_err(|e| std::io::Error::other(format!("client data directory: {e}")))? };
            let lock = config::acquire_lock(&directory).map_err(std::io::Error::other)?;
        let external_fixture = (cfg!(debug_assertions) || cfg!(feature = "smoke-test")) && std::env::var_os("TTS_RECORD_API_URL").is_some();
        let backend = if external_fixture { None } else { Some(local_backend::LocalBackend::start(app.handle(), &directory).map_err(std::io::Error::other)?) };
        let api_url = if let Some(local) = &backend { local.url.clone() } else { config::read_config(&directory).map_err(std::io::Error::other)?.api_url };
        let profile_key = if backend.is_some() { "local://embedded-v1" } else { &api_url };
        let binding = config::bind_with_lock(&directory, profile_key, lock).map_err(std::io::Error::other)?;
        let origin = binding.origin.clone(); let profile = binding.profile.clone(); let store_id = binding.store_id;
            #[cfg(target_os = "macos")] let _ = &profile;
            let handle = app.handle().clone();
            let assets = Arc::new(move |path: &str| handle.asset_resolver().get(if path == "/" { "/index.html" } else { path }.to_string())
                .map(|asset| (asset.bytes, asset.mime_type)));
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            let menu_api_origin = api_url.clone();
            let proxy = proxy::Proxy::new_with_session(api_url, origin.clone(), assets, backend.as_ref().map(|local| local.cookie.as_str()))?;
            let api = proxy.clone();
            let cache = directory.join("updates"); std::fs::create_dir_all(&cache)?;
            let updates = updates::Updates::new(app.package_info().version.to_string(), cache, app.config().product_name.as_deref() == Some("聆记 Preview"));
            let listener = binding.listener;
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("client loopback listener");
                if let Err(e) = axum::serve(listener, proxy.router()).await { eprintln!("client proxy stopped: {e}"); }
            });
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            let menu_bar = status_bar::StatusBar::new(app.handle(), &menu_api_origin)?;
            app.manage(recording_widget::RecordingWidget::default());
            app.manage(meeting_watch::MeetingWatch::default());
            app.manage(Client {
                #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
                menu_bar,
                #[cfg(target_os = "macos")]
                store_id,
                #[cfg(not(target_os = "macos"))]
                profile: profile.clone(),
                origin: origin.clone(), captures: Arc::new(audio::Captures::default()), resident: resident::Resident::default(), _lock: binding._lock, _backend: backend, updates, api });
            app.add_capability(CapabilityBuilder::new("local-capture").window("main").local(false).remote(format!("{origin}/*"))
                .permission("allow-integration-open").permission("allow-audio-backup-directory").permission("allow-client-attention").permission("allow-meeting-watch-configure").permission("allow-capture-direct-kind").permission("allow-capture-direct-control").permission("allow-capture-direct-sessions").permission("allow-capture-direct-start").permission("allow-capture-direct-progress").permission("allow-capture-direct-stop").permission("allow-capture-start").permission("allow-capture-read").permission("allow-capture-ack").permission("allow-capture-progress").permission("allow-capture-stop").permission("allow-capture-inputs")
                .permission("allow-capture-applications").permission("allow-recording-widget-update").permission("allow-client-close").permission("allow-client-ready").permission("allow-client-status").permission("allow-update-status").permission("allow-update-activity").permission("allow-update-check").permission("allow-update-download").permission("allow-update-install")
                .permission("core:event:allow-listen").permission("core:event:allow-unlisten"))?;
            app.add_capability(CapabilityBuilder::new("recording-widget").window("recording-widget").local(false).remote(format!("{origin}/*"))
                .permission("allow-recording-widget-state").permission("allow-recording-widget-ready").permission("allow-recording-widget-action")
                .permission("core:event:allow-listen").permission("core:event:allow-unlisten").permission("core:window:allow-start-dragging"))?;
            #[cfg(feature = "smoke-test")]
            app.add_capability(CapabilityBuilder::new("probe-only").window("main").local(false).remote(format!("{origin}/*")).permission("allow-client-probe"))?;
            create_main_window(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        let state = handle.state::<Client>();
                        let captures=state.captures.clone(); let _=tauri::async_runtime::spawn_blocking(move || captures.refresh_native_pending()).await;
                recording_widget::sync_visibility(&handle);
                if !state.resident.renderer_ready() { recording_widget::native_heartbeat(&handle); }
                let active = state.captures.active();
                        state.menu_bar.refresh(active, state.updates.menu(active));
                    }
                });
            }
            println!("[client] {origin}");
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) { resident::main_destroyed(window.app_handle()); }
            if window.label()=="main" && window.is_minimized().unwrap_or(false) && matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(false)) {
                recording_widget::main_hidden(window.app_handle());
            }
            if window.label()=="main" && window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
                let focused=matches!(event,tauri::WindowEvent::Focused(true));
                let resized=matches!(event,tauri::WindowEvent::Resized(_));
                if focused || resized {
                    recording_widget::main_shown(window.app_handle());
                }
            }
            if window.label()=="recording-widget" && matches!(event,tauri::WindowEvent::CloseRequested{..}) {
                if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();}
                resident::show(window.app_handle());
            }

            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); }
                let _recording_hidden=recording_widget::main_hidden(window.app_handle());
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                { let _ = window.hide(); }
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                { if _recording_hidden {let _=window.hide();} else {resident::request_quit(window.app_handle());} }
            }
        })
        .build(client_context()).expect("TTS desktop runtime")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => resident::exit_requested(app, api),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => resident::show(app),
            _ => {}
        });
}

fn create_main_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    let state = app.state::<Client>();
    let origin = state.origin.clone();
    let startup_url = state.api.startup_url();
    #[cfg(target_os = "macos")] let store_id = state.store_id;
    #[cfg(not(target_os = "macos"))] let profile = state.profile.clone();
            let client_origin = origin.clone(); let nav_handle = app.clone();
            let page_loaded = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let navigation_loaded = page_loaded.clone();
    let loaded_origin = origin.clone();
            let builder = tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External(startup_url.parse().map_err(|error: url::ParseError| error.to_string())?))
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .title("聆记 · Meeting Studio").inner_size(1280.0, 900.0).min_inner_size(760.0, 600.0)
                .on_navigation(move |url| proxy::allow_main_navigation(url, &client_origin, page_loaded.load(std::sync::atomic::Ordering::Acquire), nav_handle.state::<Client>().captures.active() || nav_handle.state::<Client>().updates.gate.installing()))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_download(|window, event| {
                    let state = window.state::<Client>();
                    if window.label() != "main" || window.url().map(|url| url.origin().ascii_serialization() != state.origin).unwrap_or(true) { return false; }
                    match event {
                        tauri::webview::DownloadEvent::Requested { url, destination } => {
                            if !downloads::allowed(&url, &state.origin) { return false; }
                            #[cfg(feature = "smoke-test")]
                            if let Ok(directory) = std::env::var("TTS_CLIENT_DOWNLOAD_TEST_DIR") {
                                let Some(filename) = destination.file_name().map(|value| value.to_owned()) else { return false; };
                                *destination = std::path::PathBuf::from(directory).join(filename);
                            }
                            #[cfg(not(feature = "smoke-test"))]
                            let _ = destination;
                            true
                        }
                        tauri::webview::DownloadEvent::Finished { url, success, .. } => {
                            let _ = window.emit("client-download-finished", serde_json::json!({ "url": url.as_str(), "success": success }));
                            true
                        }
                        _ => false,
                    }
                });
            let builder = builder.on_page_load(move |window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished && payload.url().origin().ascii_serialization() == loaded_origin {
                    navigation_loaded.store(true, std::sync::atomic::Ordering::Release);
                }
                #[cfg(not(feature = "smoke-test"))]
                let _ = window;
                #[cfg(feature = "smoke-test")]
                if payload.event() == tauri::webview::PageLoadEvent::Finished && std::env::var_os("TTS_CLIENT_PROBE_OUTPUT").is_some() {
                    if std::env::var("TTS_NATIVE_EVOLUTION_PROBE").as_deref() == Ok("1") {
                    if !NATIVE_EVOLUTION_PROBE_STARTED.swap(true,std::sync::atomic::Ordering::AcqRel) { let app=window.app_handle().clone(); tauri::async_runtime::spawn(async move { native_evolution_probe::execute(app).await; }); }
                    return;
                }
                let case = std::env::var("TTS_UPDATE_TEST_CASE").unwrap_or_default();
                    if std::env::var_os("TTS_CLIENT_DOWNLOAD_TEST_DIR").is_some() {
                        let record_id = std::env::var("TTS_CLIENT_DOWNLOAD_TEST_RECORD").unwrap_or_default();
                        let script = format!("window.__downloadRecordId={};{}", serde_json::to_string(&record_id).unwrap(), include_str!("download_probe.js"));
                        let _ = window.eval(&script);
                    } else if !case.is_empty() {
                        let script = format!("window.__updateCase={};{}", serde_json::to_string(&case).unwrap(), include_str!("update_probe.js"));
                        let _ = window.eval(&script);
                    } else { let background_ms = std::env::var("TTS_NATIVE_BACKGROUND_MS").ok().and_then(|value| value.parse::<u64>().ok()).unwrap_or(9000).clamp(9000,600000);
 let _ = window.eval(&format!("window.__nativeBackgroundMs={background_ms};{}", include_str!("probe.js"))); }
                }
            });
            #[cfg(target_os = "macos")]
            let builder = builder.data_store_identifier(store_id)
        .title_bar_style(tauri::TitleBarStyle::Transparent)
        .background_color(tauri::webview::Color(246, 249, 247, 255));
            #[cfg(not(target_os = "macos"))]
            let builder = builder.data_directory(profile.clone());
            #[cfg(target_os = "windows")]
            let builder = builder.additional_browser_args(RECORDING_BROWSER_ARGS);
            builder.build().map_err(|error| error.to_string())
}
fn client_context() -> tauri::Context<tauri::Wry> {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(feature = "smoke-test")]
    if std::env::var("TTS_UPDATE_TEST_URL").is_ok_and(|url| url.starts_with("http://127.0.0.1:")) {
        context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({"dangerousInsecureTransportProtocol":true,"requireSignedVersion":true,"pubkey":""}));
    }
    context
}
