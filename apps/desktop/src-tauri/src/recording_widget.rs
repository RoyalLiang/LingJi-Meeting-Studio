use crate::{resident, Client};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub recording: bool,
    pub microphone_on: bool,
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
    creating: bool,
    #[cfg(feature = "smoke-test")]
    hold_ready: bool,
}
impl Widget {
    fn update(&mut self, report: Report) -> bool {
        if report.recording && !self.report.recording {
            self.pending_start = true;
        }
        if !report.recording {
            self.pending_start = false;
        }
        let open = self.pending_start && self.ready && !report.busy;
        self.report = report;
        open
    }
    fn restored(&mut self) {
        self.pending_start = false;
    }
}
#[derive(Default)]
pub struct RecordingWidget(Mutex<Widget>);

#[cfg(feature = "smoke-test")]
impl RecordingWidget {
    pub fn hold_ready(&self) {
        if let Ok(mut widget) = self.0.lock() {
            widget.hold_ready = true;
            widget.ready = false;
        }
    }
    pub fn recording(&self) -> bool {
        self.0
            .lock()
            .is_ok_and(|widget| widget.report.recording && !widget.report.busy)
    }
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
    if report.recording || report.paused || report.busy {
        prepare(&app, &client)?;
    }
    app.emit_to("recording-widget", "recording-widget-state", report.clone())
        .map_err(|e| e.to_string())?;
    if open {
        show_when_ready(&app).await?;
    }
    if !report.recording && !report.paused && !report.busy {
        if let Some(floating) = app.get_webview_window("recording-widget") {
            if floating.is_visible().unwrap_or(false) {
                resident::show(&app);
            }
        }
    }
    Ok(())
}
pub fn prepare(app: &AppHandle, client: &Client) -> Result<(), String> {
    if app.get_webview_window("recording-widget").is_some() {
        return Ok(());
    }
    let state = app.state::<RecordingWidget>();
    {
        let mut widget = state.0.lock().map_err(|_| "recording status unavailable")?;
        if widget.creating {
            return Ok(());
        }
        widget.creating = true;
        widget.ready = false;
    }
    let result = (|| {
        let builder = tauri::WebviewWindowBuilder::new(
            app,
            "recording-widget",
            WebviewUrl::External(
                format!("{}#recording-widget", client.api.startup_url())
                    .parse()
                    .map_err(|_| "invalid client origin")?,
            ),
        )
        .title("聆记 · 正在记录")
        .inner_size(448.0, 42.0)
        .visible(false)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
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
            .map(|_| ())
            .map_err(|e| format!("recording window: {e}"))
    })();
    state
        .0
        .lock()
        .map_err(|_| "recording status unavailable")?
        .creating = false;
    result
}

async fn show_when_ready(app: &AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let state = handle.state::<RecordingWidget>();
            {
                let widget = state.0.lock().map_err(|_| "recording status unavailable")?;
                if !widget.pending_start
                    || !widget.ready
                    || !widget.report.recording
                    || widget.report.busy
                {
                    return Ok(());
                }
            }
            let main = handle
                .get_webview_window("main")
                .ok_or("main window unavailable")?;
            let floating = handle
                .get_webview_window("recording-widget")
                .ok_or("recording window unavailable")?;
            main.hide().map_err(|e| e.to_string())?;
            if let Err(error) = floating.show() {
                let _ = main.show();
                return Err(error.to_string());
            }
            state
                .0
                .lock()
                .map_err(|_| "recording status unavailable")?
                .pending_start = false;
            Ok(())
        })();
        let _ = send.send(result);
    })
    .map_err(|e| e.to_string())?;
    receive
        .await
        .map_err(|_| "recording window unavailable".to_string())?
}

pub fn main_shown(app: &AppHandle) {
    if let Some(state) = app.try_state::<RecordingWidget>() {
        if let Ok(mut widget) = state.0.lock() {
            widget.restored();
        }
    }
    if let Some(floating) = app.get_webview_window("recording-widget") {
        let _ = floating.hide();
    }
}

#[cfg(feature = "smoke-test")]
pub async fn release_held_ready(app: &AppHandle) -> Result<(), String> {
    {
        let state = app.state::<RecordingWidget>();
        let mut widget = state.0.lock().map_err(|_| "recording status unavailable")?;
        widget.hold_ready = false;
        widget.ready = true;
    }
    show_when_ready(app).await
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
    let widget = widget
        .0
        .lock()
        .map_err(|_| "recording status unavailable")?;
    Ok(widget.report.clone())
}
#[tauri::command]
pub async fn recording_widget_ready(
    app: AppHandle,
    window: WebviewWindow,
    client: State<'_, Client>,
    widget: State<'_, RecordingWidget>,
) -> Result<(), String> {
    authorize_widget(&window, &client)?;
    {
        let mut widget = widget
            .0
            .lock()
            .map_err(|_| "recording status unavailable")?;
        #[cfg(feature = "smoke-test")]
        if widget.hold_ready {
            return Ok(());
        }
        widget.ready = true;
    }
    show_when_ready(&app).await
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
        "microphone" if report.recording || (report.paused && report.can_resume) => "status-microphone",
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
    fn cold_window_waits_for_renderer_before_requesting_display() {
        let mut widget = Widget::default();
        assert!(!widget.update(Report {
            recording: true,
            ..Report::default()
        }));
        assert!(widget.pending_start);
        widget.ready = true;
        assert!(widget.update(Report {
            recording: true,
            ..Report::default()
        }));
    }
    #[test]
    fn restoring_main_cancels_a_late_ready_transition() {
        let mut widget = Widget::default();
        assert!(!widget.update(Report {
            recording: true,
            ..Report::default()
        }));
        widget.restored();
        widget.ready = true;
        assert!(!widget.update(Report {
            recording: true,
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
    }
    #[test]
    fn minimize_once_after_capture_is_ready_and_again_on_resume() {
        let mut widget = Widget {
            ready: true,
            ..Widget::default()
        };
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
