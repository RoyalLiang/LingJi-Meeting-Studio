fn main() {
    const COMMANDS: &[&str] = &[
        "capture_start",
        "capture_read",
        "capture_stop",
        "capture_inputs",
        "client_close",
        "client_ready",
    ];
    const PROBE_COMMANDS: &[&str] = &[
        "capture_start",
        "capture_read",
        "capture_stop",
        "capture_inputs",
        "client_close",
        "client_ready",
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
