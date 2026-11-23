use objc2::{rc::Retained, runtime::Bool, AllocAnyThread};
use objc2_foundation::{NSData, NSDataBase64DecodingOptions, NSDataBase64EncodingOptions, NSString, NSURL, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions};
use serde::Serialize;
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}, sync::Mutex};

const LIMIT: usize = 1024 * 1024;

struct ScopedUrl(Retained<NSURL>);
impl Drop for ScopedUrl {
    fn drop(&mut self) { unsafe { self.0.stopAccessingSecurityScopedResource() }; }
}
fn bookmark(url: &NSURL, options: NSURLBookmarkCreationOptions) -> Result<String, String> {
    url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(options, None, None)
        .map(|data| data.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty()).to_string())
        .map_err(|_| "无法保存目录访问授权，请重新选择目录。".into())
}
fn restore(value: &str, expected: &str) -> Result<ScopedUrl, String> {
    let data = NSData::initWithBase64EncodedString_options(NSData::alloc(), &NSString::from_str(value), NSDataBase64DecodingOptions::empty())
        .ok_or("目录访问授权无效，请重新选择目录。")?;
    let mut stale = Bool::NO;
    let url = unsafe { NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
        &data, NSURLBookmarkResolutionOptions::WithSecurityScope | NSURLBookmarkResolutionOptions::WithoutUI | NSURLBookmarkResolutionOptions::WithoutMounting,
        None, &mut stale,
    ) }.map_err(|_| "无法恢复目录访问授权，请重新选择目录。")?;
    if url.path().map(|path| path.to_string()).as_deref() != Some(expected) {
        return Err("目录已移动，请重新选择备份目录。".into());
    }
    if !unsafe { url.startAccessingSecurityScopedResource() } {
        return Err("目录访问授权已失效，请重新选择目录。".into());
    }
    Ok(ScopedUrl(url))
}
fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if bytes.len() > LIMIT { return Err("目录授权记录过大。".into()); }
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("目录授权位置无效")?).map_err(|error| error.to_string())?;
    file.write_all(&bytes).and_then(|_| file.as_file().sync_all()).map_err(|error| error.to_string())?;
    file.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}
fn read_bookmarks(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.len() > LIMIT as u64 { return Err("目录授权记录无效。".into()); }
    let values: BTreeMap<String, String> = serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?).map_err(|_| "目录授权记录已损坏。")?;
    if values.len() > 64 || values.iter().any(|(path, data)| !Path::new(path).is_absolute() || path.len() > 4096 || data.len() > 262144) {
        return Err("目录授权记录无效。".into());
    }
    Ok(values)
}
struct State {
    saved: BTreeMap<String, String>,
    active: BTreeMap<String, ScopedUrl>,
    writable: bool,
}
pub struct StoreDirectories { root: PathBuf, state: Mutex<State> }
impl StoreDirectories {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let (mut saved, writable) = match read_bookmarks(&root.join("directory-scopes.json")) {
            Ok(values) => (values, true),
            Err(_) => { eprintln!("[sandbox] directory grants could not be restored"); (BTreeMap::new(), false) },
        };
        let active: BTreeMap<_, _> = saved.iter().filter_map(|(path, data)| restore(data, path).ok().map(|url| (path.clone(), url))).collect();
        for (path, url) in &active { saved.insert(path.clone(), bookmark(&url.0, NSURLBookmarkCreationOptions::WithSecurityScope)?); }
        if writable && !active.is_empty() { atomic_json(&root.join("directory-scopes.json"), &saved)?; }
        let value = Self { root, state: Mutex::new(State { saved, active, writable }) };
        value.handoff(&*value.state.lock().map_err(|_| "目录授权暂不可用")?)?;
        Ok(value)
    }
    fn handoff(&self, state: &State) -> Result<(), String> {
        // Ordinary bookmarks transfer the active access to Node; the helper retains their URLs.
        let bookmarks: BTreeMap<String, String> = state.active.iter().map(|(path, url)| bookmark(&url.0, NSURLBookmarkCreationOptions::empty()).map(|data| (path.clone(), data))).collect::<Result<_, _>>()?;
        atomic_json(&self.root.join("directory-bookmarks.json"), &bookmarks)
    }
    pub fn grant(&self, path: &Path) -> Result<(), String> {
        let path = path.to_str().ok_or("目录名称无效")?;
        let mut state = self.state.lock().map_err(|_| "目录授权暂不可用")?;
        if !state.writable { return Err("目录授权记录已损坏，请保留数据并联系支持。".into()); }
        if !state.saved.contains_key(path) && state.saved.len() >= 64 { return Err("已保存的目录授权过多。".into()); }
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let data = bookmark(&url, NSURLBookmarkCreationOptions::WithSecurityScope)?;
        let scoped = restore(&data, path)?;
        state.saved.insert(path.into(), bookmark(&scoped.0, NSURLBookmarkCreationOptions::WithSecurityScope)?);
        state.active.insert(path.into(), scoped);
        atomic_json(&self.root.join("directory-scopes.json"), &state.saved)?;
        self.handoff(&state)
    }
}
