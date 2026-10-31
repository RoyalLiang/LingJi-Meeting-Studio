use crate::{audio::Captures, proxy::Proxy, update_gate::Gate};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const MAX_DOWNLOAD: u64 = 256 * 1024 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: String,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub installer: bool,
}
struct Downloaded {
    path: PathBuf,
    digest: [u8; 32],
    bytes: u64,
}
fn prepared_download(
    status: &Status,
    version: Option<&str>,
    downloaded: Option<(&Path, u64)>,
) -> bool {
    let Some(version) = version else {
        return false;
    };
    let Some((path, bytes)) = downloaded else {
        return false;
    };
    // Updater::check uses the updater's strict newer-version comparison. The
    // downloaded entry is created only after download and signature validation.
    version != status.current_version
        && status.version.as_deref() == Some(version)
        && bytes > 0
        && status.downloaded == bytes
        && status.total == Some(bytes)
        && std::fs::metadata(path).is_ok_and(|file| file.is_file() && file.len() == bytes)
}
struct State {
    status: Status,
    update: Option<Update>,
    downloaded: Option<Downloaded>,
    operating: bool,
    auto_download: bool,
    preview: Option<crate::preview_updates::Release>,
}
#[derive(Clone)]
pub struct Updates {
    state: Arc<Mutex<State>>,
    pub gate: Gate,
    endpoint: Option<String>,
    pubkey: Option<String>,
    cache: PathBuf,
    preview_channel: bool,
}
struct Operation(Arc<Mutex<State>>);
impl Drop for Operation {
    fn drop(&mut self) {
        self.0.lock().unwrap().operating = false;
    }
}

impl Updates {
    pub fn new(current_version: String, cache: PathBuf, preview_channel: bool) -> Self {
        let endpoint = option_env!("TTS_UPDATER_ENDPOINT")
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let pubkey = option_env!("TTS_UPDATER_PUBLIC_KEY")
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        #[cfg(feature = "smoke-test")]
        let (endpoint, pubkey) = (
            std::env::var("TTS_UPDATE_TEST_URL").ok().or(endpoint),
            std::env::var("TTS_UPDATE_TEST_PUBLIC_KEY").ok().or(pubkey),
        );
        let preview_channel = preview_channel && endpoint.is_none() && pubkey.is_none();
        let configured = preview_channel || (endpoint.is_some() && pubkey.is_some());
        Self {
            state: Arc::new(Mutex::new(State {
                status: Status {
                    phase: if configured { "idle" } else { "disabled" }.into(),
                    current_version,
                    version: None,
                    notes: None,
                    downloaded: 0,
                    total: None,
                    error: None,
                    installer: preview_channel,
                },
                update: None,
                downloaded: None,
                operating: false,
                auto_download: false,
                preview: None,
            })),
            gate: Gate::default(),
            endpoint,
            pubkey,
            cache,
            preview_channel,
        }
    }
    pub fn status(&self) -> Status {
        self.state.lock().unwrap().status.clone()
    }
    pub fn set_auto_download(&self, enabled: bool) {
        self.state.lock().unwrap().auto_download = enabled;
    }
    pub fn menu(&self, native_active: bool) -> crate::menu_status::UpdatePresentation {
        let state = self.state.lock().unwrap();
        let prepared = prepared_download(
            &state.status,
            state
                .update
                .as_ref()
                .map(|update| update.version.as_str())
                .or_else(|| {
                    state
                        .preview
                        .as_ref()
                        .map(|release| release.version.as_str())
                }),
            state
                .downloaded
                .as_ref()
                .map(|download| (download.path.as_path(), download.bytes)),
        );
        let mut view = crate::menu_status::present_update(
            &state.status.phase,
            self.preview_channel || (self.endpoint.is_some() && self.pubkey.is_some()),
            state.operating,
            self.gate.fresh(),
            state.auto_download,
            prepared,
            self.gate.reason(native_active),
        );
        if self.preview_channel {
            view.install_label = "打开安装包".into();
        }
        view
    }
    fn emit(&self, app: &AppHandle) {
        let _ = app.emit("client-update-state", self.status());
    }
    fn operation(&self) -> Result<Operation, String> {
        let mut state = self.state.lock().unwrap();
        if state.operating {
            return Err("更新操作正在进行，请稍后再试".into());
        }
        state.operating = true;
        Ok(Operation(self.state.clone()))
    }
    fn phase(&self, app: &AppHandle, phase: &str, error: Option<String>) {
        let mut state = self.state.lock().unwrap();
        state.status.phase = phase.into();
        state.status.error = error;
        drop(state);
        self.emit(app);
    }
    async fn check_inner(&self, app: &AppHandle) -> Result<(), String> {
        if self.preview_channel {
            self.phase(app, "checking", None);
            let release = crate::preview_updates::check(&self.status().current_version).await?;
            let mut state = self.state.lock().unwrap();
            if release.as_ref().map(|r| (&r.version, &r.digest))
                != state.preview.as_ref().map(|r| (&r.version, &r.digest))
            {
                if let Some(old) = state.downloaded.take() {
                    let _ = std::fs::remove_file(old.path);
                }
                state.status.downloaded = 0;
                state.status.total = None;
            }
            state.status.version = release.as_ref().map(|r| r.version.clone());
            state.status.notes = release.as_ref().and_then(|r| r.notes.clone());
            state.status.phase = if state.downloaded.is_some() {
                "ready"
            } else if release.is_some() {
                "available"
            } else {
                "current"
            }
            .into();
            state.preview = release;
            drop(state);
            self.emit(app);
            return Ok(());
        }
        let endpoint = self
            .endpoint
            .as_ref()
            .ok_or("此安装包尚未配置更新源，请手动安装新版")?;
        let url = url::Url::parse(endpoint).map_err(|_| "更新源地址无效")?;
        let secure =
            url.scheme() == "https" && url.username().is_empty() && url.password().is_none();
        #[cfg(feature = "smoke-test")]
        let secure = secure || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1"));
        if !secure {
            return Err("更新源必须使用 HTTPS，不能含账户信息".into());
        }
        self.phase(app, "checking", None);
        let builder = app
            .updater_builder()
            .pubkey(self.pubkey.as_ref().ok_or("更新签名公钥未配置")?)
            .endpoints(vec![url])
            .map_err(|e| e.to_string())?
            .timeout(Duration::from_secs(15));
        #[cfg(feature = "smoke-test")]
        let builder = if let Ok(path) = std::env::var("TTS_UPDATE_TEST_EXECUTABLE") {
            let path = std::fs::canonicalize(path).map_err(|_| "test destination unavailable")?;
            let root = std::fs::canonicalize(self.cache.parent().ok_or("test root unavailable")?)
                .map_err(|e| e.to_string())?;
            if !path.starts_with(root) {
                return Err(
                    "test updater destination must stay inside its isolated directory".into(),
                );
            }
            builder.executable_path(path)
        } else {
            builder
        };
        let update = builder
            .configure_client(|client| client.https_only(!cfg!(feature = "smoke-test")))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| format!("检查更新失败：{e}"))?;
        let mut state = self.state.lock().unwrap();
        // Preserve an already verified download when a repeated check announces the same version.
        let same = update.as_ref().map(|u| &u.version) == state.update.as_ref().map(|u| &u.version);
        if !same {
            state.status.downloaded = 0;
            state.status.total = None;
            if let Some(old) = state.downloaded.take() {
                let _ = std::fs::remove_file(old.path);
            }
        }
        state.status.version = update.as_ref().map(|u| u.version.clone());
        state.status.notes = update.as_ref().and_then(|u| {
            u.body
                .as_ref()
                .map(|body| body.chars().take(8000).collect())
        });
        state.status.phase = if state.downloaded.is_some() {
            "ready"
        } else if update.is_some() {
            "available"
        } else {
            "current"
        }
        .into();
        state.status.error = None;
        state.update = update;
        drop(state);
        self.emit(app);
        Ok(())
    }
    pub async fn check(&self, app: &AppHandle) -> Result<Status, String> {
        let _operation = self.operation()?;
        if let Err(error) = self.check_inner(app).await {
            self.phase(
                app,
                if !self.preview_channel && (self.endpoint.is_none() || self.pubkey.is_none()) {
                    "disabled"
                } else {
                    "error"
                },
                Some(error.clone()),
            );
            return Err(error);
        }
        Ok(self.status())
    }
    async fn download_inner(&self, app: &AppHandle) -> Result<(), String> {
        if self.preview_channel {
            let release = self
                .state
                .lock()
                .unwrap()
                .preview
                .clone()
                .ok_or("请先检查更新")?;
            self.phase(app, "downloading", None);
            let mut last = Instant::now() - Duration::from_secs(1);
            let path = crate::preview_updates::download(&release, &self.cache, |count| {
                if last.elapsed() < Duration::from_millis(150) {
                    return;
                }
                let mut state = self.state.lock().unwrap();
                state.status.downloaded = count;
                state.status.total = Some(release.size);
                drop(state);
                self.emit(app);
                last = Instant::now();
            })
            .await?;
            let mut state = self.state.lock().unwrap();
            state.downloaded = Some(Downloaded {
                path,
                digest: release.digest,
                bytes: release.size,
            });
            state.status.downloaded = release.size;
            state.status.total = Some(release.size);
            drop(state);
            self.phase(app, "ready", None);
            return Ok(());
        }
        let mut update = self
            .state
            .lock()
            .unwrap()
            .update
            .clone()
            .ok_or("请先检查更新")?;
        update.timeout = Some(Duration::from_secs(180));
        self.phase(app, "downloading", None);
        let (cancel, budget) = tokio::sync::oneshot::channel();
        let mut cancel = Some(cancel);
        let state = self.state.clone();
        let app_progress = app.clone();
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut downloaded = 0u64;
        let bytes = tokio::select! {
            result = update.download(move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                if downloaded > MAX_DOWNLOAD || total.is_some_and(|value| value > MAX_DOWNLOAD) { if let Some(cancel) = cancel.take() { let _ = cancel.send(()); } }
                if last.elapsed() >= Duration::from_millis(150) {
                    let mut state = state.lock().unwrap(); state.status.downloaded = downloaded; state.status.total = total;
                    let snapshot = state.status.clone(); drop(state); let _ = app_progress.emit("client-update-state", snapshot); last = Instant::now();
                }
            }, || {}) => result.map_err(|e| format!("更新下载或验签失败：{e}"))?,
            Ok(()) = budget => return Err("更新包超过 256 MiB 限制，请使用完整安装包".into()),
        };
        if bytes.len() as u64 > MAX_DOWNLOAD {
            return Err("更新包超过大小限制".into());
        }
        let free = fs2::available_space(&self.cache).map_err(|_| "无法检查更新磁盘空间")?;
        if free < bytes.len() as u64 * 3 + 64 * 1024 * 1024 {
            return Err("磁盘空间不足，未准备安装更新".into());
        }
        let path = self.cache.join("verified-update.bin");
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        std::fs::write(&path, &bytes).map_err(|e| format!("更新暂存失败：{e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        let mut state = self.state.lock().unwrap();
        state.downloaded = Some(Downloaded {
            path,
            digest,
            bytes: bytes.len() as u64,
        });
        state.status.downloaded = bytes.len() as u64;
        state.status.total = Some(bytes.len() as u64);
        drop(state);
        self.phase(app, "ready", None);
        Ok(())
    }
    pub async fn download(&self, app: &AppHandle) -> Result<Status, String> {
        let _operation = self.operation()?;
        if let Err(error) = self.download_inner(app).await {
            self.phase(app, "available", Some(error.clone()));
            return Err(error);
        }
        Ok(self.status())
    }
    pub async fn install(
        &self,
        app: &AppHandle,
        captures: &Captures,
        proxy: &Proxy,
    ) -> Result<(), String> {
        let _operation = self.operation()?;
        let permit = self.gate.install(captures.active())?;
        #[cfg(feature="smoke-test")]
        let fixture = !self.preview_channel && std::env::var_os("TTS_UPDATE_TEST_EXECUTABLE").is_some();
        #[cfg(not(feature="smoke-test"))]
        let fixture = false;
        let confirmation=app.clone();
        let accepted=fixture || tauri::async_runtime::spawn_blocking(move || confirmation.dialog().message("退出聆记并安装更新？已保存的录音和会议数据将保留。安装期间请勿关机。")
            .title("安装版本更新").buttons(MessageDialogButtons::OkCancelCustom("退出并安装".into(),"暂不安装".into())).blocking_show()).await.map_err(|e|e.to_string())?;
        if !accepted {self.phase(app,"ready",None);return Ok(());}

        if self.preview_channel {
            let (path, digest, bytes) = {
                let state = self.state.lock().unwrap();
                let downloaded = state.downloaded.as_ref().ok_or("请先下载安装包")?;
                (downloaded.path.clone(), downloaded.digest, downloaded.bytes)
            };
            let result = async {
                proxy.update_barrier().await?;
                crate::preview_updates::verify(&path, bytes, &digest)?;
                permit.validate(captures.active())?;
                let handoff=crate::preview_updates::open(app, &path, self.status().version.as_deref().unwrap_or(""), || permit.validate(captures.active()))?;
                self.phase(app,"installing",None);
                if let Err(error)=crate::resident::finish_update(app) {handoff.cancel();return Err(error);}
                Ok(())
            }
            .await;
            if result.is_err() {self.phase(app, "ready", result.as_ref().err().cloned());}
            return result;
        }
        #[cfg(target_os = "linux")]
        if std::env::var_os("APPIMAGE").is_none() {
            return Err("此 Linux 安装格式需要通过系统包管理器更新".into());
        }
        let (update, path, digest, bytes) = {
            let state = self.state.lock().unwrap();
            let downloaded = state
                .downloaded
                .as_ref()
                .ok_or("更新包尚未下载并通过验签")?;
            (
                state.update.clone().ok_or("更新信息已失效")?,
                downloaded.path.clone(),
                downloaded.digest,
                downloaded.bytes,
            )
        };
        self.phase(app, "installing", None);
        let result = async {
            proxy.update_barrier().await?;
            permit.validate(captures.active())?;
            if fs2::available_space(&self.cache).map_err(|_| "无法检查磁盘空间")?
                < bytes * 3 + 64 * 1024 * 1024
            {
                return Err("磁盘空间不足，已取消安装".into());
            }
            let mut data = Vec::new();
            use std::io::Read;
            std::fs::File::open(path)
                .map_err(|_| "已下载更新无法读取，请重新下载")?
                .take(bytes + 1)
                .read_to_end(&mut data)
                .map_err(|_| "更新包读取失败")?;
            if data.len() as u64 != bytes {
                return Err("暂存更新包长度已变化，请重新下载".into());
            }
            if <[u8; 32]>::from(Sha256::digest(&data)) != digest {
                return Err("暂存更新包已变化，请重新下载".into());
            }
            permit.validate(captures.active())?;
            tauri::async_runtime::spawn_blocking(move || update.install(data))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("更新安装失败：{e}"))?;
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            self.phase(app, "ready", Some(error.clone()));
            return Err(error);
        }
        #[cfg(feature = "smoke-test")]
        if std::env::var_os("TTS_UPDATE_TEST_EXECUTABLE").is_some() {
            self.phase(app, "installed", None);
            return Ok(());
        }
        // Windows' installer path may already have exited this process. Never call install before the gate.
        #[cfg(not(target_os = "windows"))]
        app.restart();
        #[cfg(target_os = "windows")]
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_requires_the_announced_new_version_and_a_complete_download_on_disk() {
        let directory =
            std::env::temp_dir().join(format!("lingji-menu-update-{}", getrandom::u64().unwrap()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("synthetic-verified-update.bin");
        let mut status = Status {
            phase: "ready".into(),
            current_version: "1.0.0".into(),
            version: Some("1.1.0".into()),
            notes: None,
            downloaded: 4,
            total: Some(4),
            error: None,
            installer: false,
        };
        assert!(!prepared_download(&status, Some("1.1.0"), Some((&path, 4))));
        std::fs::write(&path, b"test").unwrap();
        assert!(prepared_download(&status, Some("1.1.0"), Some((&path, 4))));
        assert!(!prepared_download(&status, None, Some((&path, 4))));
        assert!(!prepared_download(&status, Some("1.1.0"), None));
        assert!(!prepared_download(&status, Some("1.0.0"), Some((&path, 4))));
        assert!(!prepared_download(&status, Some("1.2.0"), Some((&path, 4))));
        assert!(!prepared_download(&status, Some("1.1.0"), Some((&path, 0))));
        status.version = Some("1.0.0".into());
        assert!(!prepared_download(&status, Some("1.0.0"), Some((&path, 4))));
        status.version = Some("1.1.0".into());
        status.downloaded = 3;
        assert!(!prepared_download(&status, Some("1.1.0"), Some((&path, 4))));
        status.downloaded = 4;
        status.total = Some(5);
        assert!(!prepared_download(&status, Some("1.1.0"), Some((&path, 4))));
        status.total = Some(4);
        std::fs::write(&path, b"cut").unwrap();
        assert!(!prepared_download(&status, Some("1.1.0"), Some((&path, 4))));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
