use crate::menu_status::{present, Presentation, Report, UpdatePresentation};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

pub struct StatusBar {
    tray: TrayIcon<Wry>,
    menu: Menu<Wry>,
    report: Mutex<Option<(Report, Instant)>>,
    last: Mutex<Option<Presentation>>,
    record: MenuItem<Wry>,
    status: MenuItem<Wry>,
    connection: MenuItem<Wry>,
    queue: MenuItem<Wry>,
    pause: MenuItem<Wry>,
    resume: MenuItem<Wry>,
    finish: MenuItem<Wry>,
    settings: MenuItem<Wry>,
    update_check: MenuItem<Wry>,
    update_background: CheckMenuItem<Wry>,
    update_install: MenuItem<Wry>,
    last_update: Mutex<Option<UpdatePresentation>>,
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

impl StatusBar {
    pub fn new(app: &AppHandle, api_origin: &str) -> tauri::Result<Self> {
        let item = |id: &str, label: &str, enabled: bool| {
            MenuItem::with_id(app, id, label, enabled, None::<&str>)
        };
        let version = item(
            "status-version",
            &format!("聆记 · {}", app.package_info().version),
            false,
        )?;
        let server = item("status-server", &format!("服务：{api_origin}"), false)?;
        let record = item("status-record", "未选择会议", false)?;
        let status = item("status-capture", "正在读取会议状态…", false)?;
        let connection = item("status-connection", "后台状态待确认", false)?;
        let queue = item("status-queue", "待上传音频：待确认", false)?;
        let open = item("status-open", "打开聆记", true)?;
        let pause = item("status-pause", "暂停记录", false)?;
        let resume = item("status-resume", "继续本场", false)?;
        let finish = item("status-finish", "结束本场…", false)?;
        let settings = item("status-settings", "设置与诊断…", false)?;
        let update_check = item("status-update-check", "检查更新…", false)?;
        let update_background = CheckMenuItem::with_id(
            app,
            "status-update-background",
            "自动下载更新",
            false,
            false,
            None::<&str>,
        )?;
        let update_install = item("status-update-install", "重启更新", false)?;
        let hide = item("status-hide", "隐藏窗口", true)?;
        let quit = item("status-quit", "退出聆记…", true)?;
        let first = PredefinedMenuItem::separator(app)?;
        let second = PredefinedMenuItem::separator(app)?;
        let third = PredefinedMenuItem::separator(app)?;
        let updates_separator = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(
            app,
            &[
                &version,
                &server,
                &record,
                &status,
                &connection,
                &queue,
                &first,
                &open,
                &pause,
                &resume,
                &finish,
                &second,
                &settings,
                &updates_separator,
                &update_check,
                &hide,
                &third,
                &quit,
            ],
        )?;
        let tray = TrayIconBuilder::with_id("lingji-status")
            .icon(if cfg!(target_os = "macos") { tauri::include_image!("icons/menu-bar.png") } else { tauri::include_image!("icons/icon.png") })
            .icon_as_template(cfg!(target_os = "macos"))
            .tooltip("聆记 · 打开会议或右键查看状态")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show(tray.app_handle());
                }
            })
            .on_menu_event(|app, event| match event.id.as_ref() {
                "status-open" => show(app),
                "status-hide" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
                "status-quit" => crate::resident::request_quit(app),
                "status-pause"
                | "status-resume"
                | "status-finish"
                | "status-settings"
                | "status-update-check"
                | "status-update-background"
                | "status-update-install" => {
                    show(app);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.emit("client-menu-action", event.id.as_ref());
                    }
                }
                _ => {}
            })
            .build(app)?;
        Ok(Self {
            tray,
            menu,
            report: Mutex::new(None),
            last: Mutex::new(None),
            record,
            status,
            connection,
            queue,
            pause,
            resume,
            finish,
            settings,
            update_check,
            update_background,
            update_install,
            last_update: Mutex::new(None),
        })
    }
    pub fn report(&self, report: Report) {
        *self.report.lock().unwrap() = Some((report, Instant::now()));
    }
    pub fn has_pending(&self) -> bool {
        self.report
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(r, _)| r.pending_count > 0)
    }
    fn update_item_visibility(
        &self,
        item: &dyn IsMenuItem<Wry>,
        after: &str,
        visible: bool,
    ) -> tauri::Result<()> {
        let items = self.menu.items()?;
        let kind = item.kind();
        let exists = items.iter().any(|existing| existing.id() == kind.id());
        if visible && !exists {
            let position = items
                .iter()
                .position(|existing| existing.id().as_ref() == after)
                .map_or(items.len(), |index| index + 1);
            self.menu.insert(item, position)?;
        } else if !visible && exists {
            self.menu.remove(item)?;
        }
        Ok(())
    }
    fn apply_update_presentation(&self, updates: &UpdatePresentation) -> tauri::Result<()> {
        self.update_check.set_text(&updates.check_label)?;
        self.update_check.set_enabled(updates.check)?;
        self.update_background.set_enabled(updates.background)?;
        self.update_background.set_checked(updates.auto_download)?;
        self.update_install.set_enabled(updates.install)?;
        self.update_item_visibility(
            &self.update_background,
            "status-update-check",
            updates.background_visible,
        )?;
        self.update_item_visibility(
            &self.update_install,
            if updates.background_visible {
                "status-update-background"
            } else {
                "status-update-check"
            },
            updates.install_visible,
        )?;
        Ok(())
    }
    pub fn refresh(&self, native_active: bool, updates: UpdatePresentation) {
        {
            let mut last = self.last_update.lock().unwrap();
            if last.as_ref() != Some(&updates) {
                if self.apply_update_presentation(&updates).is_ok() {
                    *last = Some(updates);
                }
            }
        }
        let guard = self.report.lock().unwrap();
        let empty = Report::default();
        let (report, fresh) = guard
            .as_ref()
            .map(|(r, time)| (r, time.elapsed() < Duration::from_secs(5)))
            .unwrap_or((&empty, false));
        let view = present(report, native_active, fresh);
        drop(guard);
        {
            let mut last = self.last.lock().unwrap();
            if last.as_ref() == Some(&view) {
                return;
            }
            *last = Some(view.clone());
        }
        let _ = self.tray.set_title(Some(&view.title));
        let _ = self
            .tray
            .set_tooltip(Some(format!("聆记 · {} · {}", view.status, view.queue)));
        let _ = self.record.set_text(&view.record);
        let _ = self.status.set_text(&view.status);
        let _ = self.connection.set_text(&view.connection);
        let _ = self.queue.set_text(&view.queue);
        let _ = self.pause.set_enabled(view.pause);
        let _ = self.resume.set_enabled(view.resume);
        let _ = self.finish.set_enabled(view.finish);
        let _ = self.settings.set_enabled(view.settings);
    }
}
