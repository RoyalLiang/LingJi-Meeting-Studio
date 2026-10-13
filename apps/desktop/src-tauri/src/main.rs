#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod audio;
mod config;
mod menu_status;
mod proxy;
#[cfg(target_os = "macos")]
mod status_bar;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tauri::{
    ipc::{CapabilityBuilder, Response},
    Emitter, Manager, State, WebviewUrl, WebviewWindow,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

struct Client {
    #[cfg(target_os = "macos")]
    menu_bar: status_bar::StatusBar,
    origin: String,
    captures: Arc<audio::Captures>,
    ready: AtomicBool,
    close_serial: AtomicU64,
    _lock: std::fs::File,
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
    if !["display", "microphone"].contains(&kind.as_str()) {
        return Err("未知音源".into());
    }
    #[cfg(feature = "smoke-test")]
    if std::env::var("TTS_CLIENT_SYNTHETIC").as_deref() == Ok("1") {
        return state.captures.synthetic(&kind);
    }
    let prompt = if kind == "display" {
        "允许接入整台电脑的播放音频？\n可能包括其他应用声音。此授权不包含麦克风、原音留存、云端识别或分享许可。macOS 需要 14.6+ 和系统音频权限。"
    } else {
        "允许接入麦克风？\n麦克风与会议软件的静音开关独立。此授权不包含原音留存、云端识别或分享许可。"
    };
    let dialog = window
        .dialog()
        .message(prompt)
        .title("接入会议音源")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "允许".into(),
            "取消".into(),
        ));
    let allowed = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .map_err(|e| e.to_string())?;
    if !allowed {
        return Err("音源接入已取消".into());
    }
    authorize(&window, &state)?;
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
    #[cfg(target_os = "macos")]
    state.menu_bar.report(report);
    #[cfg(not(target_os = "macos"))]
    let _ = report;
    Ok(())
}

fn menu_has_pending(state: &Client) -> bool {
    #[cfg(target_os = "macos")]
    {
        state.menu_bar.has_pending()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        false
    }
}

#[tauri::command]
fn client_ready(window: WebviewWindow, state: State<'_, Client>) -> Result<(), String> {
    authorize(&window, &state)?;
    state.ready.store(true, Ordering::Release);
    Ok(())
}

#[cfg(feature = "smoke-test")]
#[tauri::command]
fn client_probe(
    window: WebviewWindow,
    state: State<'_, Client>,
    result: serde_json::Value,
) -> Result<(), String> {
    authorize(&window, &state)?;
    let path =
        std::env::var("TTS_CLIENT_PROBE_OUTPUT").map_err(|_| "probe output not configured")?;
    std::fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn client_close(
    window: WebviewWindow,
    state: State<'_, Client>,
    force: bool,
) -> Result<(), String> {
    authorize(&window, &state)?;
    state.close_serial.fetch_add(1, Ordering::AcqRel);
    if force || state.captures.active() || menu_has_pending(&state) {
        let dialog = window.dialog().message("录音或补传尚未完成。请先在会议中暂停或结束，并等待补传完成。\n强制关闭会停止原生采集，尚未保存的末尾音频可能丢失。已持久化的片段会在重启并重新登录同一服务后保留。").title("录音尚未完成")
            .buttons(MessageDialogButtons::OkCancelCustom("强制关闭".into(), "留在会议".into()));
        if !tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(());
        }
    }
    state.captures.stop_all();
    window.destroy().map_err(|e| e.to_string())
}

fn main() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "smoke-test")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        capture_start,
        capture_read,
        capture_stop,
        capture_inputs,
        client_ready,
        client_status,
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
        client_close
    ]);
    builder
        .setup(|app| {
            let directory = std::env::var("TTS_CLIENT_DATA_DIR").map(std::path::PathBuf::from).unwrap_or(app.path().app_config_dir()?);
            let config = config::read_config(&directory).map_err(std::io::Error::other)?;
            let binding = config::bind(&directory, &config.api_url).map_err(std::io::Error::other)?;
            let origin = binding.origin.clone(); let profile = binding.profile.clone(); let store_id = binding.store_id;
            let handle = app.handle().clone();
            let assets = Arc::new(move |path: &str| handle.asset_resolver().get(if path == "/" { "/index.html" } else { path }.to_string())
                .map(|asset| (asset.bytes, asset.mime_type)));
            #[cfg(target_os = "macos")]
            let menu_api_origin = config.api_url.clone();
            let proxy = proxy::Proxy::new(config.api_url, origin.clone(), assets)?;
            let startup_url = proxy.startup_url();
            let listener = binding.listener;
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("client loopback listener");
                if let Err(e) = axum::serve(listener, proxy.router()).await { eprintln!("client proxy stopped: {e}"); }
            });
            #[cfg(target_os = "macos")]
            let menu_bar = status_bar::StatusBar::new(app.handle(), &menu_api_origin)?;
            app.manage(Client {
                #[cfg(target_os = "macos")]
                menu_bar, origin: origin.clone(), captures: Arc::new(audio::Captures::default()), ready: AtomicBool::new(false), close_serial: AtomicU64::new(0), _lock: binding._lock });
            app.add_capability(CapabilityBuilder::new("local-capture").window("main").local(false).remote(format!("{origin}/*"))
                .permission("allow-capture-start").permission("allow-capture-read").permission("allow-capture-stop").permission("allow-capture-inputs")
                .permission("allow-client-close").permission("allow-client-ready").permission("allow-client-status")
                .permission("core:event:allow-listen").permission("core:event:allow-unlisten"))?;
            #[cfg(feature = "smoke-test")]
            app.add_capability(CapabilityBuilder::new("probe-only").window("main").local(false).remote(format!("{origin}/*")).permission("allow-client-probe"))?;
            let client_origin = origin.clone(); let nav_handle = app.handle().clone();
            let builder = tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External(startup_url.parse()?))
                .title("聆记 · Meeting Studio").inner_size(1280.0, 900.0).min_inner_size(760.0, 600.0)
                .on_navigation(move |url| url.origin().ascii_serialization() == client_origin && !nav_handle.state::<Client>().captures.active())
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            #[cfg(feature = "smoke-test")]
            let builder = builder.on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished && std::env::var_os("TTS_CLIENT_PROBE_OUTPUT").is_some() {
                    let _ = window.eval(include_str!("probe.js"));
                }
            });
            #[cfg(target_os = "macos")]
            let builder = builder.data_store_identifier(store_id);
            #[cfg(not(target_os = "macos"))]
            let builder = builder.data_directory(profile.clone());
            let _ = (profile, store_id);
            builder.build()?;
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        let state = handle.state::<Client>();
                        state.menu_bar.refresh(state.captures.active());
                    }
                });
            }
            println!("[client] {origin}");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<Client>();
                if state.ready.load(Ordering::Acquire) || state.captures.active() {
                    api.prevent_close(); let serial = state.close_serial.fetch_add(1, Ordering::AcqRel) + 1;
                    let _ = window.emit("client-close-requested", ());
                    let window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        if window.state::<Client>().close_serial.load(Ordering::Acquire) != serial { return; }
                        let dialog = window.dialog().message("会议页面未响应关闭请求。强制关闭可能丢失尚未保存的末尾音频；已保存的片段会保留。")
                            .buttons(MessageDialogButtons::OkCancelCustom("强制关闭".into(), "取消".into()));
                        if tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await.unwrap_or(false) {
                            window.state::<Client>().captures.stop_all(); let _ = window.destroy();
                        }
                    });
                }
            }
        })
        .run(tauri::generate_context!()).expect("TTS desktop runtime");
}
