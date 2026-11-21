use fs2::FileExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: String,
    files: Vec<RuntimeFile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeFile {
    path: String,
    size: u64,
    sha256: String,
}

fn plain(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !metadata.file_type().is_symlink()
}

fn directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let info = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !info.is_dir() || !plain(&info) {
        return Err("Runtime cache directory is redirected".into());
    }
    Ok(())
}

fn hash_file(path: &Path, expected_size: u64) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|e| e.to_string())?
        .take(expected_size + 1);
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0;
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        size += count as u64;
    }
    if size != expected_size {
        return Err("Runtime file size changed while reading".into());
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn expected_files(bytes: &[u8]) -> Result<BTreeMap<String, (u64, String)>, String> {
    if bytes.len() > 1024 * 1024 {
        return Err("Runtime manifest is too large".into());
    }
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if manifest.version.split('.').count() != 4
        || manifest
            .version
            .split('.')
            .any(|n| n.parse::<u16>().is_err())
        || manifest.files.is_empty()
        || manifest.files.len() > 4096
    {
        return Err("Invalid runtime manifest".into());
    }
    let mut files = BTreeMap::new();
    let mut names = std::collections::BTreeSet::new();
    let mut total = 0u64;
    for entry in manifest.files {
        let path = Path::new(&entry.path);
        if entry.path.is_empty()
            || entry.path.len() > 1024
            || entry.path.split('/').count() > 32
            || entry.path.contains(['\\', ':'])
            || entry.path.chars().any(char::is_control)
            || entry
                .path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || path
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
            || entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !names.insert(entry.path.to_lowercase())
        {
            return Err("Invalid runtime file entry".into());
        }
        total = total
            .checked_add(entry.size)
            .ok_or("Runtime size overflow")?;
        if total > 2 * 1024 * 1024 * 1024 {
            return Err("Runtime is too large".into());
        }
        files.insert(entry.path, (entry.size, entry.sha256));
    }
    for required in [
        "msedgewebview2.exe",
        "msedge.dll",
        "EBWebView/x64/EmbeddedBrowserWebView.dll",
    ] {
        if !files.contains_key(required) {
            return Err("Incomplete runtime manifest".into());
        }
    }
    Ok(files)
}

fn inventory(
    root: &Path,
    path: &Path,
    expected: &BTreeMap<String, (u64, String)>,
    pending: &mut Vec<(String, PathBuf, u64)>,
) -> Result<(), String> {
    let info = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !plain(&info) {
        return Err("Runtime cache contains a redirected entry".into());
    }
    let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
    let name = relative
        .components()
        .map(|part| {
            part.as_os_str()
                .to_str()
                .ok_or("Invalid runtime cache filename")
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    if info.is_dir() {
        let prefix = name.clone() + "/";
        if !name.is_empty() && !expected.keys().any(|file| file.starts_with(&prefix)) {
            return Err("Unexpected runtime cache directory".into());
        }
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            inventory(
                root,
                &entry.map_err(|e| e.to_string())?.path(),
                expected,
                pending,
            )?;
        }
    } else if info.is_file() {
        let (size, _) = expected.get(&name).ok_or("Unexpected runtime cache file")?;
        if info.len() != *size {
            return Err("Runtime cache file size changed".into());
        }
        pending.push((name, path.to_path_buf(), *size));
    } else {
        return Err("Runtime cache contains a special file".into());
    }
    Ok(())
}

fn verify(path: &Path, expected: &BTreeMap<String, (u64, String)>) -> Result<(), String> {
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    };
    let mut pending = Vec::with_capacity(expected.len());
    inventory(path, path, expected, &mut pending)?;
    if pending.len() != expected.len() {
        return Err("Runtime cache integrity check failed".into());
    }
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .clamp(1, 8)
        .min(pending.len().max(1));
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let first_error: Mutex<Option<String>> = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                while !failed.load(Ordering::Acquire) {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some((name, file_path, size)) = pending.get(index) else {
                        break;
                    };
                    let check = hash_file(file_path, *size).and_then(|digest| {
                        if expected.get(name).is_some_and(|(_, want)| want == &digest) {
                            Ok(())
                        } else {
                            Err("Runtime cache integrity check failed".into())
                        }
                    });
                    if let Err(err) = check {
                        failed.store(true, Ordering::Release);
                        let mut slot = first_error.lock().unwrap();
                        if slot.is_none() {
                            *slot = Some(err);
                        }
                        break;
                    }
                }
            });
        }
    });
    if let Some(err) = first_error.into_inner().unwrap() {
        return Err(err);
    }
    Ok(())
}

pub fn prepare(package: &Path, cache: &Path) -> Result<PathBuf, String> {
    let mut bytes = Vec::new();
    File::open(package.join("webview2-files.json"))
        .map_err(|e| e.to_string())?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let expected = expected_files(&bytes)?;
    directory(cache)?;
    let lock_path = cache.join("prepare.lock");
    if let Ok(info) = fs::symlink_metadata(&lock_path) {
        if !plain(&info) || !info.is_file() {
            return Err("Invalid runtime cache lock".into());
        }
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    // shortcut: retain other runtime caches until pruning can identify versions still running.
    let destination = cache.join(format!("{:x}", Sha256::digest(&bytes)));
    if verify(&destination, &expected).is_ok() {
        return Ok(destination);
    }
    let temporary = tempfile::Builder::new()
        .prefix("prepare-")
        .tempdir_in(cache)
        .map_err(|e| e.to_string())?;
    for (name, (size, _)) in &expected {
        let target = temporary.path().join(name);
        fs::create_dir_all(target.parent().ok_or("Missing runtime directory")?)
            .map_err(|e| e.to_string())?;
        let mut input =
            File::open(package.join("webview2").join(name)).map_err(|e| e.to_string())?;
        let mut output = File::create_new(target).map_err(|e| e.to_string())?;
        if std::io::copy(&mut input.take(size + 1), &mut output).map_err(|e| e.to_string())?
            != *size
        {
            return Err("Packaged runtime changed while copying".into());
        }
        output.sync_all().map_err(|e| e.to_string())?;
    }
    verify(temporary.path(), &expected)?;
    if let Ok(info) = fs::symlink_metadata(&destination) {
        if !info.is_dir() || !plain(&info) {
            return Err("Invalid runtime cache destination".into());
        }
        fs::remove_dir_all(&destination).map_err(|e| e.to_string())?;
    }
    fs::rename(temporary.path(), &destination).map_err(|e| e.to_string())?;
    Ok(destination)
}

#[cfg(windows)]
pub fn cache_root() -> Result<PathBuf, String> {
    use windows::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath, KF_FLAG_NO_PACKAGE_REDIRECTION},
    };
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentPackageFamilyName(length: *mut u32, value: *mut u16) -> i32;
    }
    let mut length = 0;
    if unsafe { GetCurrentPackageFamilyName(&mut length, std::ptr::null_mut()) } != 122
        || length > 512
    {
        return Err("Cannot query package family".into());
    }
    let mut family = vec![0u16; length as usize];
    if unsafe { GetCurrentPackageFamilyName(&mut length, family.as_mut_ptr()) } != 0 || length < 2 {
        return Err("Cannot read package family".into());
    }
    let family = String::from_utf16(&family[..length as usize - 1]).map_err(|e| e.to_string())?;
    let pointer = unsafe {
        SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_NO_PACKAGE_REDIRECTION, None)
    }
    .map_err(|e| e.to_string())?;
    let root = unsafe { pointer.to_string() }
        .map(PathBuf::from)
        .map_err(|e| e.to_string());
    unsafe { CoTaskMemFree(Some(pointer.0.cast())) };
    let package = root?.join("Packages").join(family);
    directory(&package.join("LocalCache"))?;
    Ok(package.join("LocalCache").join("WebView2"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let package = root.path().join("package");
        let cache = root.path().join("cache");
        fs::create_dir_all(package.join("webview2/EBWebView/x64")).unwrap();
        let mut files = Vec::new();
        for name in [
            "msedgewebview2.exe",
            "msedge.dll",
            "EBWebView/x64/EmbeddedBrowserWebView.dll",
            "empty",
        ] {
            let bytes = if name == "empty" { "" } else { name };
            fs::write(package.join("webview2").join(name), bytes).unwrap();
            files.push(serde_json::json!({"path":name,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes.as_bytes()))}));
        }
        fs::write(
            package.join("webview2-files.json"),
            serde_json::to_vec(&serde_json::json!({"version":"157.0.4341.60","files":files}))
                .unwrap(),
        )
        .unwrap();
        (root, package, cache)
    }
    #[test]
    fn prepares_reuses_and_repairs_only_runtime_cache() {
        let (_root, package, cache) = fixture();
        fs::write(package.join("recording.txt"), "keep").unwrap();
        let runtime = prepare(&package, &cache).unwrap();
        fs::write(cache.join("recording.txt"), "keep sibling").unwrap();
        assert_eq!(runtime, prepare(&package, &cache).unwrap());
        fs::write(runtime.join("msedge.dll"), "corrupt").unwrap();
        fs::write(runtime.join("unexpected.dll"), "extra").unwrap();
        assert_eq!(runtime, prepare(&package, &cache).unwrap());
        assert_eq!(
            fs::read_to_string(runtime.join("msedge.dll")).unwrap(),
            "msedge.dll"
        );
        assert!(!runtime.join("unexpected.dll").exists());
        assert_eq!(
            fs::read_to_string(package.join("recording.txt")).unwrap(),
            "keep"
        );
        assert_eq!(
            fs::read_to_string(cache.join("recording.txt")).unwrap(),
            "keep sibling"
        );
    }
    #[test]
    fn failed_copy_preserves_previous_cache() {
        let (_root, package, cache) = fixture();
        let runtime = prepare(&package, &cache).unwrap();
        fs::write(runtime.join("msedge.dll"), "old-corrupt").unwrap();
        fs::write(package.join("webview2/msedge.dll"), "source-corrupt").unwrap();
        assert!(prepare(&package, &cache).is_err());
        assert_eq!(
            fs::read_to_string(runtime.join("msedge.dll")).unwrap(),
            "old-corrupt"
        );
    }
    #[test]
    fn rejects_escaping_case_colliding_and_invalid_hash_entries() {
        let (_root, package, _cache) = fixture();
        let bytes = fs::read(package.join("webview2-files.json")).unwrap();
        for name in [
            "../outside",
            "/outside",
            "a/../b",
            "a//b",
            "a\\b",
            "C:/outside",
            "msedge.dll",
        ] {
            let mut manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            manifest["files"][3]["path"] = name.into();
            assert!(
                expected_files(&serde_json::to_vec(&manifest).unwrap()).is_err(),
                "{name}"
            );
        }
        let mut manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        manifest["files"][3]["sha256"] = "invalid".into();
        assert!(expected_files(&serde_json::to_vec(&manifest).unwrap()).is_err());
        manifest["files"][3] = manifest["files"][0].clone();
        manifest["files"][3]["path"] = "MSEDGEWEBVIEW2.EXE".into();
        assert!(expected_files(&serde_json::to_vec(&manifest).unwrap()).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_redirected_cache_without_touching_target() {
        let (root, package, cache) = fixture();
        let runtime = prepare(&package, &cache).unwrap();
        fs::remove_dir_all(&runtime).unwrap();
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep"), "safe").unwrap();
        std::os::unix::fs::symlink(&outside, &runtime).unwrap();
        assert!(prepare(&package, &cache).is_err());
        assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "safe");
    }
}
