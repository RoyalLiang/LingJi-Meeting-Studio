#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod audio;
mod config;
mod downloads;
mod local_backend;
mod menu_status;
mod proxy;
mod resident;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod status_bar;
mod update_gate;
mod updates;
use std::sync::Arc;
use tauri::{
    ipc::{CapabilityBuilder, Response},
    Emitter, Manager, State, WebviewUrl, WebviewWindow,
};

struct Client {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    menu_bar: status_bar::StatusBar,
    origin: String,
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
) -> Result<(), String> {
    authorize(&window, &state)?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    state.menu_bar.report(report);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = report;
    Ok(())
}

fn menu_has_pending(state: &Client) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        state.menu_bar.has_pending()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = state;
        false
    }
}

#[tauri::command]
fn client_ready(window: WebviewWindow, state: State<'_, Client>) -> Result<(), String> {
    authorize(&window, &state)?;
    state.resident.ready();
    Ok(())
}

#[cfg(feature = "smoke-test")]
#[tauri::command]
fn client_probe(
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
        capture_start,
        capture_read,
        capture_stop,
        capture_inputs,
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
        capture_start,
        capture_read,
        capture_stop,
        capture_inputs,
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
            let handle = app.handle().clone();
            let assets = Arc::new(move |path: &str| handle.asset_resolver().get(if path == "/" { "/index.html" } else { path }.to_string())
                .map(|asset| (asset.bytes, asset.mime_type)));
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            let menu_api_origin = api_url.clone();
            let proxy = proxy::Proxy::new_with_session(api_url, origin.clone(), assets, backend.as_ref().map(|local| local.cookie.as_str()))?;
            let startup_url = proxy.startup_url();
            let api = proxy.clone();
            let cache = directory.join("updates"); std::fs::create_dir_all(&cache)?;
            let updates = updates::Updates::new(app.package_info().version.to_string(), cache);
            let listener = binding.listener;
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("client loopback listener");
                if let Err(e) = axum::serve(listener, proxy.router()).await { eprintln!("client proxy stopped: {e}"); }
            });
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            let menu_bar = status_bar::StatusBar::new(app.handle(), &menu_api_origin)?;
            app.manage(Client {
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                menu_bar, origin: origin.clone(), captures: Arc::new(audio::Captures::default()), resident: resident::Resident::default(), _lock: binding._lock, _backend: backend, updates, api });
            app.add_capability(CapabilityBuilder::new("local-capture").window("main").local(false).remote(format!("{origin}/*"))
                .permission("allow-capture-start").permission("allow-capture-read").permission("allow-capture-stop").permission("allow-capture-inputs")
                .permission("allow-client-close").permission("allow-client-ready").permission("allow-client-status").permission("allow-update-status").permission("allow-update-activity").permission("allow-update-check").permission("allow-update-download").permission("allow-update-install")
                .permission("core:event:allow-listen").permission("core:event:allow-unlisten"))?;
            #[cfg(feature = "smoke-test")]
            app.add_capability(CapabilityBuilder::new("probe-only").window("main").local(false).remote(format!("{origin}/*")).permission("allow-client-probe"))?;
            let client_origin = origin.clone(); let nav_handle = app.handle().clone();
            let builder = tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External(startup_url.parse()?))
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .title("聆记 · Meeting Studio").inner_size(1280.0, 900.0).min_inner_size(760.0, 600.0)
                .on_navigation(move |url| url.origin().ascii_serialization() == client_origin && !nav_handle.state::<Client>().captures.active() && !nav_handle.state::<Client>().updates.gate.installing())
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
            #[cfg(feature = "smoke-test")]
            let builder = builder.on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished && std::env::var_os("TTS_CLIENT_PROBE_OUTPUT").is_some() {
                    let case = std::env::var("TTS_UPDATE_TEST_CASE").unwrap_or_default();
                    if std::env::var_os("TTS_CLIENT_DOWNLOAD_TEST_DIR").is_some() {
                        let record_id = std::env::var("TTS_CLIENT_DOWNLOAD_TEST_RECORD").unwrap_or_default();
                        let script = format!("window.__downloadRecordId={};{}", serde_json::to_string(&record_id).unwrap(), include_str!("download_probe.js"));
                        let _ = window.eval(&script);
                    } else if !case.is_empty() {
                        let script = format!("window.__updateCase={};{}", serde_json::to_string(&case).unwrap(), include_str!("update_probe.js"));
                        let _ = window.eval(&script);
                    } else { let _ = window.eval(include_str!("probe.js")); }
                }
            });
            #[cfg(target_os = "macos")]
            let builder = builder.data_store_identifier(store_id);
            #[cfg(not(target_os = "macos"))]
            let builder = builder.data_directory(profile.clone());
            let _ = (profile, store_id);
            builder.build()?;
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        let state = handle.state::<Client>();
                        let active = state.captures.active();
                        state.menu_bar.refresh(active, state.updates.menu(active));
                    }
                });
            }
            println!("[client] {origin}");
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); }
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                { let _ = window.hide(); }
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                resident::request_quit(window.app_handle());
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

fn client_context() -> tauri::Context<tauri::Wry> {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(feature = "smoke-test")]
    if std::env::var("TTS_UPDATE_TEST_URL").is_ok_and(|url| url.starts_with("http://127.0.0.1:")) {
        context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({"dangerousInsecureTransportProtocol":true,"requireSignedVersion":true,"pubkey":""}));
    }
    context
}
