use crate::{resident, Client};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub recording: bool,
    pub paused: bool,
    pub can_resume: bool,
    pub busy: bool,
    pub duration_ms: u64,
    pub rms: f64,
}
#[derive(Default)]
struct Widget {
    report: Report,
    pending_start: bool,
    ready: bool,
}
impl Widget {
    fn update(&mut self, report: Report) -> bool {
        if report.recording && !self.report.recording {
            self.pending_start = true;
        }
        if !report.recording {
            self.pending_start = false;
        }
        let open = self.pending_start && !report.busy;
        self.report = report;
        open
    }
}
#[derive(Default)]
pub struct RecordingWidget(Mutex<Widget>);

#[cfg(feature = "smoke-test")]
impl RecordingWidget {
    pub fn ready(&self) -> bool {
        self.0.lock().is_ok_and(|widget| widget.ready)
    }
    pub fn can_resume(&self) -> bool {
        self.0.lock().is_ok_and(|widget| widget.report.can_resume)
    }
    pub fn duration_ms(&self) -> u64 {
        self.0
            .lock()
            .map(|widget| widget.report.duration_ms)
            .unwrap_or(0)
    }
}

#[tauri::command]
pub async fn recording_widget_update(
    app: AppHandle,
    window: WebviewWindow,
    client: State<'_, Client>,
    widget: State<'_, RecordingWidget>,
    report: Report,
) -> Result<(), String> {
    crate::authorize(&window, &client)?;
    if !report.rms.is_finite()
        || !(0.0..=1.0).contains(&report.rms)
        || (report.recording && report.paused)
    {
        return Err("invalid recording status".into());
    }
    let open = widget
        .0
        .lock()
        .map_err(|_| "recording status unavailable")?
        .update(report.clone());
    if open {
        let floating = match app.get_webview_window("recording-widget") {
            Some(window) => window,
            None => {
                let builder = tauri::WebviewWindowBuilder::new(
                    &app,
                    "recording-widget",
                    WebviewUrl::External(
                        format!("{}#recording-widget", client.api.startup_url())
                            .parse()
                            .map_err(|_| "invalid client origin")?,
                    ),
                )
                .title("聆记 · 正在记录")
                .inner_size(416.0, 84.0)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .on_navigation({
                    let origin = client.origin.clone();
                    move |url| url.origin().ascii_serialization() == origin
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
                #[cfg(target_os = "macos")]
                let builder = builder.data_store_identifier(client.store_id);
                #[cfg(not(target_os = "macos"))]
                let builder = builder.data_directory(client.profile.clone());
                #[cfg(target_os = "windows")]
                let builder = builder.additional_browser_args(crate::RECORDING_BROWSER_ARGS);
                builder
                    .build()
                    .map_err(|e| format!("recording window: {e}"))?
            }
        };
        floating.show().map_err(|e| e.to_string())?;
        let ready = widget
            .0
            .lock()
            .map_err(|_| "recording status unavailable")?
            .ready;
        if ready {
            window.minimize().map_err(|e| e.to_string())?;
            widget
                .0
                .lock()
                .map_err(|_| "recording status unavailable")?
                .pending_start = false;
        }
    }
    if !report.recording && !report.paused && !report.busy {
        if let Some(floating) = app.get_webview_window("recording-widget") {
            if floating.is_visible().unwrap_or(false) {
                resident::show(&app);
            }
        }
    }
    app.emit_to("recording-widget", "recording-widget-state", report)
        .map_err(|e| e.to_string())
}
fn authorize_widget(window: &WebviewWindow, client: &Client) -> Result<(), String> {
    if window.label() != "recording-widget"
        || window
            .url()
            .map(|u| u.origin().ascii_serialization() != client.origin)
            .unwrap_or(true)
    {
        return Err("untrusted recording window".into());
    }
    Ok(())
}
#[tauri::command]
pub fn recording_widget_state(
    window: WebviewWindow,
    client: State<'_, Client>,
    widget: State<'_, RecordingWidget>,
) -> Result<Report, String> {
    authorize_widget(&window, &client)?;
    let mut widget = widget
        .0
        .lock()
        .map_err(|_| "recording status unavailable")?;
    widget.ready = true;
    Ok(widget.report.clone())
}
#[tauri::command]
pub fn recording_widget_action(
    app: AppHandle,
    window: WebviewWindow,
    client: State<'_, Client>,
    widget: State<'_, RecordingWidget>,
    action: String,
) -> Result<(), String> {
    authorize_widget(&window, &client)?;
    let report = widget
        .0
        .lock()
        .map_err(|_| "recording status unavailable")?
        .report
        .clone();
    if action == "restore" {
        resident::show(&app);
        return Ok(());
    }
    if report.busy {
        return Err("recording operation in progress".into());
    }
    let event = match action.as_str() {
        "pause" if report.recording => "status-pause",
        "pause" if report.paused && report.can_resume => "status-resume",
        "finish" if report.recording || report.paused => {
            resident::show(&app);
            "status-finish"
        }
        _ => return Err("invalid recording action".into()),
    };
    app.emit_to("main", "client-menu-action", event)
        .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn minimize_once_after_capture_is_ready_and_again_on_resume() {
        let mut widget = Widget::default();
        assert!(!widget.update(Report {
            recording: true,
            busy: true,
            ..Report::default()
        }));
        assert!(widget.update(Report {
            recording: true,
            ..Report::default()
        }));
        widget.pending_start = false;
        assert!(!widget.update(Report {
            recording: true,
            duration_ms: 2000,
            ..Report::default()
        }));
        assert!(!widget.update(Report {
            paused: true,
            ..Report::default()
        }));
        assert!(widget.update(Report {
            recording: true,
            ..Report::default()
        }));
        assert!(!widget.update(Report::default()));
    }
}
