use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::Path,
    time::Duration,
};

const RELEASES: &str = "https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases.atom";
const MAX_PACKAGE: u64 = 1024 * 1024 * 1024;
#[derive(Clone)]
pub struct Release {
    pub version: String,
    pub notes: Option<String>,
    pub name: String,
    pub url: String,
    pub size: u64,
    pub digest: [u8; 32],
}
fn version(value: &str) -> Option<[u64; 3]> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut result = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty()
            || !part.bytes().all(|c| c.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        result[index] = part.parse().ok()?;
    }
    Some(result)
}
fn digest(value: &str) -> Option<[u8; 32]> {
    let hex = value.strip_prefix("sha256:")?;
    if hex.len() != 64 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut result = [0; 32];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(result)
}
pub fn select(
    releases: &Value,
    current: &str,
    platform: &str,
    arch: &str,
) -> Result<Option<Release>, String> {
    let current = version(current).ok_or("当前版本格式无效")?;
    let suffix = match (platform, arch) {
        ("macos", "aarch64") => "macos-arm64.dmg",
        ("windows", "x86_64") => "windows-x64-setup.exe",
        ("linux", "x86_64") => "linux-amd64.deb",
        _ => return Err("此平台暂无 Preview 自动下载包".into()),
    };
    let releases = releases.as_array().ok_or("更新源返回格式无效")?;
    let mut candidate = None;
    let mut newest = current;
    for release in releases {
        if release["draft"].as_bool() != Some(false) {
            continue;
        }
        let Some(tag) = release["tag_name"].as_str() else {
            continue;
        };
        let Some(number) = tag.strip_prefix('v').and_then(version) else {
            continue;
        };
        if number <= newest {
            continue;
        }
        let v = &tag[1..];
        let name = format!("Lingji-{v}-{suffix}");
        let expected_url = format!(
            "https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/{tag}/{name}"
        );
        let asset = release["assets"].as_array().and_then(|items| {
            items
                .iter()
                .find(|item| item["name"].as_str() == Some(&name))
        });
        let Some(asset) = asset else {
            continue;
        };
        let size = asset["size"]
            .as_u64()
            .filter(|size| *size > 0 && *size <= MAX_PACKAGE)
            .ok_or("更新包大小无效")?;
        let hash = asset["digest"]
            .as_str()
            .and_then(digest)
            .ok_or("更新包缺少 GitHub SHA-256 校验信息")?;
        if asset["browser_download_url"].as_str() != Some(&expected_url)
            || asset["state"].as_str() != Some("uploaded")
        {
            return Err("更新包地址或状态无效".into());
        }
        newest = number;
        candidate = Some(Release {
            version: v.into(),
            notes: release["body"]
                .as_str()
                .map(|text| text.chars().take(8000).collect()),
            name,
            url: expected_url,
            size,
            digest: hash,
        });
    }
    Ok(candidate)
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Lingji-Preview-Updater")
        .https_only(true)
        .timeout(Duration::from_secs(15 * 60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("too many redirects");
            }
            if attempt.url().scheme() == "https"
                && matches!(
                    attempt.url().host_str(),
                    Some(
                        "github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                )
            {
                attempt.follow()
            } else {
                attempt.error("unexpected update host")
            }
        }))
        .build()
        .map_err(|error| error.to_string())
}
async fn read(url: &str) -> Result<Vec<u8>, String> {
    let mut response = client()?
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| format!("检查 Preview 更新失败：{error}"))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("更新源返回内容过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn latest_tag(feed: &str, current: &str) -> Result<Option<String>, String> {
    if !feed.contains("<feed ") || !feed.contains("</feed>") {
        return Err("更新订阅源格式无效".into());
    }
    let current = version(current).ok_or("当前版本格式无效")?;
    let mut versions = Vec::new();
    // GitHub escapes release-body HTML. Read only real entry links before content.
    for entry in feed.split("<entry>").skip(1) {
        let header = entry.split("<content").next().unwrap_or("");
        for link in header.split("<link ").skip(1) {
            let Some((attributes, _)) = link.split_once('>') else {
                continue;
            };
            let Some((_, rest)) = attributes.split_once(
                "href=\"https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v",
            ) else {
                continue;
            };
            let tag = rest.split('"').next().unwrap_or("");
            if let Some(number) = version(tag) {
                versions.push((number, tag));
            }
        }
    }
    if versions.is_empty() {
        return Err("更新订阅源缺少可识别版本，请稍后重试".into());
    }
    Ok(versions
        .into_iter()
        .filter(|(v, _)| *v > current)
        .max_by_key(|(v, _)| *v)
        .map(|(_, tag)| format!("v{tag}")))
}
fn manifest_release(
    manifest: Value,
    tag: &str,
    current: &str,
    platform: &str,
    arch: &str,
) -> Result<Release, String> {
    if manifest["tag_name"].as_str() != Some(tag) || manifest["draft"].as_bool() != Some(false) {
        return Err("更新清单版本或发布状态不符".into());
    }
    select(&Value::Array(vec![manifest]), current, platform, arch)?
        .ok_or_else(|| "新版清单未提供当前平台安装包".into())
}
pub async fn check(current: &str) -> Result<Option<Release>, String> {
    let bytes = read(RELEASES).await?;
    let feed = std::str::from_utf8(&bytes).map_err(|_| "更新订阅源编码无效")?;
    let Some(tag) = latest_tag(feed, current)? else {
        return Ok(None);
    };
    let url =
        format!("https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/{tag}/preview-update.json");
    let manifest: Value = serde_json::from_slice(&read(&url).await?).map_err(|_| "更新清单无效")?;
    Ok(Some(manifest_release(
        manifest,
        &tag,
        current,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )?))
}
pub fn verify(path: &Path, size: u64, digest: &[u8; 32]) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "已下载安装包不可用，请重新下载")?;
    if !metadata.is_file() || metadata.len() != size {
        return Err("安装包长度已变化，请重新下载".into());
    }
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut count = 0;
    loop {
        let n = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > size {
            return Err("安装包长度已变化，请重新下载".into());
        }
        hash.update(&buffer[..n]);
    }
    if count != size || <[u8; 32]>::from(hash.finalize()) != *digest {
        return Err("安装包 SHA-256 不符，请重新下载".into());
    }
    Ok(())
}
pub async fn download(
    release: &Release,
    cache: &Path,
    mut progress: impl FnMut(u64),
) -> Result<std::path::PathBuf, String> {
    if fs2::available_space(cache).map_err(|_| "无法检查下载磁盘空间")?
        < release.size * 3 + 64 * 1024 * 1024
    {
        return Err("磁盘空间不足，未下载安装包".into());
    }
    let mut response = client()?
        .get(&release.url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| format!("下载安装包失败：{error}"))?;
    if response
        .content_length()
        .is_some_and(|size| size != release.size)
    {
        return Err("安装包下载长度不符".into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(cache).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("下载中断：{error}"))?
    {
        count = count.saturating_add(chunk.len() as u64);
        if count > release.size {
            return Err("安装包超过预期长度".into());
        }
        temporary
            .write_all(&chunk)
            .map_err(|error| format!("安装包保存失败：{error}"))?;
        hash.update(&chunk);
        progress(count);
    }
    if count != release.size || <[u8; 32]>::from(hash.finalize()) != release.digest {
        return Err("安装包 SHA-256 或长度不符，已丢弃下载".into());
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    let extension = Path::new(&release.name)
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("安装包扩展名无效")?;
    let path = cache.join(format!("preview-installer.{extension}"));
    temporary
        .persist(&path)
        .map_err(|error| error.to_string())?;
    Ok(path)
}
pub fn open(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("/usr/bin/open")
        .arg(path)
        .spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new(path).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();
    result
        .map(|_| ())
        .map_err(|error| format!("无法打开安装包：{error}"))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn release(v: &str) -> Value {
        json!({"draft":false,"prerelease":true,"tag_name":format!("v{v}"),"assets":[{"name":format!("Lingji-{v}-macos-arm64.dmg"),"state":"uploaded","size":42,"digest":format!("sha256:{}","ab".repeat(32)),"browser_download_url":format!("https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/download/v{v}/Lingji-{v}-macos-arm64.dmg")}]})
    }
    #[test]
    fn discovery_uses_only_complete_feed_and_exact_repository_version_links() {
        let feed = r#"<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.9"/><link href="https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.31"/><link href="https://github.com/other/repo/releases/tag/v99.0.0"/><link href="https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v0.1.32-beta"/><content type="html">&lt;a href="https://github.com/RoyalLiang/LingJi-Meeting-Studio/releases/tag/v99.0.0"&gt;bad&lt;/a&gt;</content></entry></feed>"#;
        assert_eq!(
            latest_tag(feed, "0.1.30").unwrap().as_deref(),
            Some("v0.1.31")
        );
        assert!(latest_tag(feed, "0.1.31").unwrap().is_none());
        assert!(latest_tag("<feed ", "0.1.30").is_err());
    }
    #[test]
    fn newer_manifest_missing_platform_or_unpublished_is_an_error() {
        let mut value = release("0.1.31");
        value["assets"] = json!([]);
        assert!(manifest_release(value, "v0.1.31", "0.1.30", "macos", "aarch64").is_err());
        let mut value = release("0.1.31");
        value["draft"] = json!(true);
        assert!(manifest_release(value, "v0.1.31", "0.1.30", "macos", "aarch64").is_err());
        assert!(
            manifest_release(release("0.1.31"), "v0.1.32", "0.1.30", "macos", "aarch64").is_err()
        );
        assert!(latest_tag(
            r#"<feed xmlns="atom"><entry><title>unrecognized</title></entry></feed>"#,
            "0.1.30"
        )
        .is_err());
    }
    #[test]
    fn preview_selects_newer_numeric_versions_and_requires_pinned_asset_integrity() {
        let releases = json!([release("0.1.9"), release("0.1.31"), release("0.1.30")]);
        assert_eq!(
            select(&releases, "0.1.29", "macos", "aarch64")
                .unwrap()
                .unwrap()
                .version,
            "0.1.31"
        );
        assert!(select(&releases, "0.1.31", "macos", "aarch64")
            .unwrap()
            .is_none());
        for key in ["digest", "browser_download_url", "state", "size"] {
            let mut bad = release("0.1.32");
            bad["assets"][0][key] = json!(null);
            assert!(
                select(&json!([bad]), "0.1.30", "macos", "aarch64").is_err(),
                "{key}"
            );
        }
        let mut draft = release("0.1.99");
        draft["draft"] = json!(true);
        assert!(select(&json!([draft]), "0.1.30", "macos", "aarch64")
            .unwrap()
            .is_none());
        for v in ["1.2.3-beta.1", "01.2.3", "1.2", "1.2.3/evil", "١.2.3"] {
            assert!(version(v).is_none());
        }
    }
    #[tokio::test]
    #[ignore = "downloads the public Preview installer from GitHub"]
    async fn live_preview_check_download_and_verify() {
        let release = check("0.1.0").await.unwrap().expect("published Preview");
        let dir = tempfile::tempdir().unwrap();
        let mut observed = 0;
        let path = download(&release, dir.path(), |count| observed = count)
            .await
            .unwrap();
        assert_eq!(observed, release.size);
        verify(&path, release.size, &release.digest).unwrap();
        println!(
            "verified Preview {}: {} bytes",
            release.version, release.size
        );
    }
    #[test]
    fn downloaded_installer_rejects_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.dmg");
        std::fs::write(&path, b"original").unwrap();
        let hash = Sha256::digest(b"original").into();
        verify(&path, 8, &hash).unwrap();
        std::fs::write(&path, b"tampered").unwrap();
        assert!(verify(&path, 8, &hash).is_err());
        std::fs::write(&path, b"short").unwrap();
        assert!(verify(&path, 8, &hash).is_err());
    }
}
