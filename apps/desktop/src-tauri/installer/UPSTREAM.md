# Installer template origin

Base: [Tauri CLI v2.12.2 NSIS template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi). Upstream source SHA-256: `166f9677d42e81c7f712a1bf80d9d8c089c21d2967d8398474768b5eac14b494`.

The template keeps Tauri upgrade, uninstall, WebView2, resources and execution checks. LingJi replaces welcome/destination/finish with full-background nsDialogs pages, chooses a per-user Programs/LingJi directory, and collects desktop shortcut preference before installation. Actual code and assets are reproducible in scripts/installer-background.mjs. Never replace the template from a moving upstream branch without reviewing changes.

Tauri is dual licensed MIT or Apache-2.0. This adapted template is redistributed under the included upstream MIT license.
