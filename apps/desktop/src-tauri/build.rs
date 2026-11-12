fn main() {
    build_dsp();
    println!("cargo:rerun-if-env-changed=TTS_UPDATER_ENDPOINT");
    println!("cargo:rerun-if-env-changed=TTS_UPDATER_PUBLIC_KEY");
    const COMMANDS: &[&str] = &[
        "integration_open",
        "audio_backup_directory",
        "client_attention",
        "meeting_watch_configure",
        "capture_start",
        "capture_direct_start", "capture_direct_progress", "capture_direct_stop", "capture_direct_sessions", "capture_direct_control", "capture_direct_kind",
        "recording_widget_update",
        "recording_widget_state",
        "recording_widget_ready",
        "recording_widget_action",
        "capture_read",
        "capture_ack",
        "capture_progress",
        "capture_stop",
        "capture_inputs",
        "capture_applications",
        "client_close",
        "client_ready",
        "client_status",
        "client_theme",
        "update_status",
        "update_activity",
        "update_check",
        "update_download",
        "update_install",
    ];
    const PROBE_COMMANDS: &[&str] = &[
        "integration_open",
        "audio_backup_directory",
        "client_attention",
        "meeting_watch_configure",
        "capture_start",
        "capture_direct_start", "capture_direct_progress", "capture_direct_stop", "capture_direct_sessions", "capture_direct_control", "capture_direct_kind",
        "recording_widget_update",
        "recording_widget_state",
        "recording_widget_ready",
        "recording_widget_action",
        "capture_read",
        "capture_ack",
        "capture_progress",
        "capture_stop",
        "capture_inputs",
        "capture_applications",
        "client_close",
        "client_ready",
        "client_status",
        "client_theme",
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

fn build_dsp() {
    let root = "vendor/speexdsp";
    println!("cargo:rerun-if-changed={root}");
    cc::Build::new().include(format!("{root}/include")).include(format!("{root}/libspeexdsp"))
        .define("FLOATING_POINT",None).define("USE_KISS_FFT",None).define("EXPORT",Some(""))
        .define("_USE_MATH_DEFINES",None).flag_if_supported("-std=c99").flag_if_supported("/std:c11")
        .files(["mdf","preprocess","filterbank","fftwrap","kiss_fft","kiss_fftr"].map(|name|format!("{root}/libspeexdsp/{name}.c")))
        .warnings(false).compile("lingji_speexdsp");
}
