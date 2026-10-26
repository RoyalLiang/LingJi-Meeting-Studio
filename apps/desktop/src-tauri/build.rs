fn main() {
    println!("cargo:rerun-if-env-changed=TTS_UPDATER_ENDPOINT");
    println!("cargo:rerun-if-env-changed=TTS_UPDATER_PUBLIC_KEY");
    const COMMANDS: &[&str] = &[
        "capture_start",
        "recording_widget_update",
        "recording_widget_state",
        "recording_widget_ready",
        "recording_widget_action",
        "capture_read",
        "capture_stop",
        "capture_inputs",
        "client_close",
        "client_ready",
        "client_status",
        "update_status",
        "update_activity",
        "update_check",
        "update_download",
        "update_install",
    ];
    const PROBE_COMMANDS: &[&str] = &[
        "capture_start",
        "recording_widget_update",
        "recording_widget_state",
        "recording_widget_ready",
        "recording_widget_action",
        "capture_read",
        "capture_stop",
        "capture_inputs",
        "client_close",
        "client_ready",
        "client_status",
        "update_status",
        "update_activity",
        "update_check",
        "update_download",
        "update_install",
        "client_probe",
    ];
    let commands = if std::env::var_os("CARGO_FEATURE_SMOKE_TEST").is_some() {
        PROBE_COMMANDS
    } else {
        COMMANDS
    };
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("desktop build configuration");
}
