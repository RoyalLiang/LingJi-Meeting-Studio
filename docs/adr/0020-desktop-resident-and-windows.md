# 0020: Desktop residence and Windows installer

Status: proposed. User confirmed full-background installation preview and cross-platform background residence on 2026-10-24; implementation is authorized within that scope.

Keep the main WebView and Rust capture/Node backend owners alive when a window closes. Windows uses the system tray; macOS uses the menu bar and Dock reopen. Explicit app/OS Quit enters a serialized renderer preflight and existing capture/unsent-audio confirmation; hiding never sends beforeunload or stops sources. Updater install retains its own capture/drain guard. Reopening an already running standard profile restores that instance; explicit developer/test profiles retain their existing independent directory locks. Login autostart and model service startup are separate and unchanged.

Windows x64 uses official Tauri NSIS packaging with pinned template, full-width generated jade background, destination and shortcut options, finish/launch, per-user installation, bundled Node and an offline WebView2 installer. No Python or speech model weights are included. Preserve installed user data and reject upgrades/uninstall while the resident app is running rather than force-killing active recording.

Release must bind macOS and Windows metadata and checksums to one source SHA. CI must exercise native hidden synthetic capture and restart replay separately from production installer/backend smoke; neither proves physical device or long-meeting acceptance.

References: [tray](https://v2.tauri.app/learn/system-tray/), [NSIS packaging](https://v2.tauri.app/distribute/windows-installer/), [single instance](https://v2.tauri.app/plugin/single-instance/).

Windows CI confirmed EPERM at directory fsync after an audio object was linked. Windows now flushes the committed object with a writable file handle after the staged data flush and before ACK; macOS/Linux keep the directory barrier. Flush failures still propagate; no simulated success or silent fallback. NTFS physical power-loss behavior is not claimed by synthetic process-restart tests. See [Microsoft FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).
