use serde::Deserialize;
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};
use tauri::Manager;

#[derive(Deserialize)]
struct Handshake {
    protocol: u32,
    url: String,
    cookie: String,
    sqlite: String,
}

pub struct LocalBackend {
    child: Mutex<Child>,
    input: Option<ChildStdin>,
    pub url: String,
    pub cookie: String,
}

impl LocalBackend {
    pub fn start(app: &tauri::AppHandle, directory: &Path) -> Result<Self, String> {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|e| format!("客户端资源目录不可用：{e}"))?;
        let mut runtime =
            resources
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        let mut entry = resources.join("client-backend/services/records/src/desktop-backend.mjs");
        if cfg!(debug_assertions) && !runtime.is_file() {
            let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
            runtime = dev
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
            entry = dev.join("client-backend/services/records/src/desktop-backend.mjs");
        }
        if !runtime.is_file() || !entry.is_file() {
            return Err("安装包缺少客户端后台运行时；开发环境请先运行 node scripts/prepare-client-backend.mjs".into());
        }
        let root = directory.join("backend");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let log = root.join("runtime.log");
        let mut log_options = OpenOptions::new();
        log_options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            log_options.mode(0o600);
        }
        log_options.open(&log).map_err(|e| e.to_string())?;
        let mut command = Command::new(runtime);
        command
            .arg(entry)
            .arg(&root)
            .current_dir(&root)
            .env_clear()
            .env("NODE_ENV", "desktop")
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "SystemRoot"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("客户端后台无法启动：{e}"))?;
        let stdout = child.stdout.take().ok_or("客户端后台握手不可用")?;
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let mut lines = VecDeque::new();
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    lines.push_back(line.chars().take(512).collect::<String>());
                    if lines.len() > 32 {
                        lines.pop_front();
                    }
                    let _ = fs::write(&log, lines.iter().cloned().collect::<Vec<_>>().join("\n"));
                }
            });
        }
        let (send, receive) = mpsc::channel();
        thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout)
                .read_line(&mut line)
                .map_err(|e| e.to_string())
                .and_then(|_| {
                    serde_json::from_str::<Handshake>(&line)
                        .map_err(|_| "客户端后台未返回有效握手".to_string())
                });
            let _ = send.send(result);
        });
        let ready = receive.recv_timeout(Duration::from_secs(15));
        let handshake = match ready {
            Ok(Ok(value)) => value,
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("客户端后台启动失败，请检查独立数据目录中的 runtime.log".into());
            }
        };
        let sqlite: Vec<u32> = handshake
            .sqlite
            .split('.')
            .filter_map(|value| value.parse().ok())
            .collect();
        if sqlite.as_slice() < [3, 51, 3].as_slice() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("客户端 SQLite 运行时版本不受支持".into());
        }
        let url = url::Url::parse(&handshake.url).map_err(|_| "客户端后台地址无效")?;
        if handshake.protocol != 1
            || url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || !handshake.cookie.starts_with("record_session=")
            || handshake.cookie.contains(['\r', '\n'])
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("客户端后台握手校验失败".into());
        }
        Ok(Self {
            input: child.stdin.take(),
            child: Mutex::new(child),
            url: handshake.url,
            cookie: handshake.cookie,
        })
    }
}

impl Drop for LocalBackend {
    fn drop(&mut self) {
        self.input.take(); // EOF tells only this owned backend to stop.
        if let Ok(child) = self.child.get_mut() {
            for _ in 0..40 {
                if child.try_wait().ok().flatten().is_some() {
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
