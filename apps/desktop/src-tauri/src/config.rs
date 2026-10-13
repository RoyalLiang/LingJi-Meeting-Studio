use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    net::TcpListener,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub api_url: String,
}
pub struct Binding {
    pub listener: TcpListener,
    pub origin: String,
    pub profile: PathBuf,
    pub store_id: [u8; 16],
    pub _lock: File,
}

pub fn api_origin(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|_| "服务地址无效")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("API 地址须为 HTTPS 根地址，本机开发可使用 http://127.0.0.1:3030；不得包含账户、路径、查询或片段".into());
    }
    Ok(url.origin().ascii_serialization())
}

pub fn read_config(directory: &Path) -> Result<Config, String> {
    let value = if let Ok(value) = std::env::var("TTS_RECORD_API_URL") {
        value
    } else {
        let path = directory.join("client.json");
        if path.exists() {
            serde_json::from_slice::<Config>(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
                .api_url
        } else {
            "http://127.0.0.1:3030".into()
        }
    };
    Ok(Config {
        api_url: api_origin(&value)?,
    })
}

pub fn bind(directory: &Path, api_url: &str) -> Result<Binding, String> {
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("client.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "此客户端已打开，请使用已有窗口".to_string())?;
    let registry = directory.join("profiles.json");
    let mut profiles: BTreeMap<String, u16> = if registry.exists() {
        serde_json::from_slice(&fs::read(&registry).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        BTreeMap::new()
    };
    let hash = Sha256::digest(api_url.as_bytes());
    let port = if let Some(port) = profiles.get(api_url) {
        *port
    } else {
        let start = 49_152 + u16::from_le_bytes([hash[0], hash[1]]) % 16_384;
        (0..16_384)
            .map(|n| 49_152 + ((u32::from(start - 49_152) + n) % 16_384) as u16)
            .find(|port| !profiles.values().any(|value| value == port))
            .ok_or("客户端配置数量超过限制")?
    };
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|_| format!("本机端口 {port} 被占用；请释放此端口后重试。为保留离线队列，客户端不会自动更换来源地址。"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    profiles.insert(api_url.to_string(), port);
    fs::write(
        registry.with_extension("tmp"),
        serde_json::to_vec_pretty(&profiles).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    fs::rename(registry.with_extension("tmp"), registry).map_err(|e| e.to_string())?;
    let profile = directory.join("profiles").join(format!("{:x}", hash));
    fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    Ok(Binding {
        listener,
        origin: format!("http://127.0.0.1:{port}"),
        profile,
        store_id: hash[..16].try_into().unwrap(),
        _lock: lock,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_urls() {
        for url in [
            "file:///a",
            "http://example.com",
            "https://a:b@example.com",
            "https://example.com/api",
            "https://example.com/?token=x",
            "https://example.com/#x",
        ] {
            assert!(api_origin(url).is_err(), "{url}");
        }
        assert_eq!(
            api_origin("https://example.com/").unwrap(),
            "https://example.com"
        );
        assert!(api_origin("http://127.0.0.1:3030").is_ok());
    }
    #[test]
    fn profiles_survive_restart_and_do_not_reuse_origins() {
        let root = std::env::temp_dir().join(format!("tts-profile-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let first = bind(&root, "https://a.test").unwrap();
        let origin = first.origin.clone();
        assert!(bind(&root, "https://b.test").is_err());
        drop(first);
        let second = bind(&root, "https://a.test").unwrap();
        assert_eq!(origin, second.origin);
        drop(second);
        let third = bind(&root, "https://b.test").unwrap();
        assert_ne!(origin, third.origin);
        drop(third);
        fs::remove_dir_all(root).unwrap();
    }
}
