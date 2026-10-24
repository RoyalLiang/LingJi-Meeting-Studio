use crate::{menu_has_pending, Client};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, ExitRequestApi, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Default)]
pub struct Resident {
    ready: AtomicBool,
    waiting: AtomicBool,
    serial: AtomicU64,
    exiting: AtomicBool,
}

impl Resident {
    pub fn ready(&self) { self.ready.store(true, Ordering::Release); }
    fn begin(&self) -> Option<u64> {
        self.waiting.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).ok()?;
        Some(self.serial.fetch_add(1, Ordering::AcqRel) + 1)
    }
    fn cancel(&self) {
        self.serial.fetch_add(1, Ordering::AcqRel);
        self.waiting.store(false, Ordering::Release);
    }
    fn unanswered(&self, serial: u64) -> bool {
        self.waiting.load(Ordering::Acquire) && self.serial.load(Ordering::Acquire) == serial
    }
}

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn finish(app: &AppHandle) {
    let state = app.state::<Client>();
    state.resident.exiting.store(true, Ordering::Release);
    state.captures.stop_all();
    app.exit(0);
}

#[cfg(feature = "smoke-test")]
pub fn probe_exit(app: &AppHandle) { finish(app); }

// A window close never enters this handshake. Explicit Quit and OS Quit do.
pub fn request_quit(app: &AppHandle) {
    let Some(state) = app.try_state::<Client>() else { return; };
    if state.updates.gate.installing() { return; }
    let Some(serial) = state.resident.begin() else { return; };
    show(app);
    let Some(window) = app.get_webview_window("main") else { finish(app); return; };
    if !state.resident.ready.load(Ordering::Acquire) && !state.captures.active() && !menu_has_pending(&state) {
        finish(app); return;
    }
    let _ = window.emit("client-close-requested", ());
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let state = window.state::<Client>();
        if state.updates.gate.installing() || !state.resident.unanswered(serial) { return; }
        let dialog = window.dialog().message("会议页面未响应退出请求。强制退出可能丢失尚未保存的末尾音频；已保存的片段会保留。")
            .title("退出聆记").buttons(MessageDialogButtons::OkCancelCustom("强制退出".into(), "留在聆记".into()));
        let accepted = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await.unwrap_or(false);
        if state.updates.gate.installing() || !state.resident.unanswered(serial) { return; }
        if accepted {
            finish(window.app_handle());
        } else { state.resident.cancel(); }
    });
}

pub async fn confirm_quit(window: &WebviewWindow, force: bool) -> Result<(), String> {
    let state = window.state::<Client>();
    if !state.resident.waiting.load(Ordering::Acquire) { return Err("请通过退出菜单退出聆记".into()); }
    state.resident.serial.fetch_add(1, Ordering::AcqRel);
    if state.updates.gate.installing() {
        state.resident.cancel(); return Err("更新正在安装，请稍候".into());
    }
    if force || state.captures.active() || menu_has_pending(&state) {
        let dialog = window.dialog().message("录音或补传尚未完成。请先在会议中暂停或结束，并等待补传完成。\n强制退出会停止原生采集，尚未保存的末尾音频可能丢失。已持久化的片段会在重启后保留。")
            .title("录音尚未完成").buttons(MessageDialogButtons::OkCancelCustom("强制退出".into(), "留在会议".into()));
        if !tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await.unwrap_or(false) {
            state.resident.cancel(); return Ok(());
        }
    }
    finish(window.app_handle());
    Ok(())
}

pub fn exit_requested(app: &AppHandle, api: ExitRequestApi) {
    let Some(state) = app.try_state::<Client>() else { return; };
    if state.resident.exiting.load(Ordering::Acquire) { return; }
    api.prevent_exit();
    request_quit(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quit_is_serialized_and_cancellation_invalidates_timeout() {
        let lifecycle = Resident::default();
        let first = lifecycle.begin().unwrap();
        assert!(lifecycle.unanswered(first));
        assert!(lifecycle.begin().is_none());
        lifecycle.cancel();
        assert!(!lifecycle.unanswered(first));
        let second = lifecycle.begin().unwrap();
        assert_ne!(first, second);
        assert!(!lifecycle.unanswered(first));
        assert!(lifecycle.unanswered(second));
    }
    #[test]
    fn renderer_acknowledgement_invalidates_force_exit_timeout() {
        let lifecycle = Resident::default();
        let serial = lifecycle.begin().unwrap();
        lifecycle.serial.fetch_add(1, Ordering::AcqRel);
        assert!(!lifecycle.unanswered(serial));
        assert!(lifecycle.begin().is_none());
        lifecycle.cancel();
        assert!(lifecycle.begin().is_some());
    }
}
