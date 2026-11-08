use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_PACKET: usize = 12 + 16_000 * 2;
const RESERVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BACKLOG: u64 = 1024 * 1024 * 1024;
fn failure(error: impl std::fmt::Display) -> String {
    format!("本机录音缓存写入失败，采集已停止，已保存片段仍保留：{error}")
}
#[cfg(test)]
thread_local! { static FAIL_DIRECTORY_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
#[cfg(test)]
pub(crate) fn fail_next_directory_sync() { FAIL_DIRECTORY_SYNC.with(|fail| fail.set(true)); }
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(test)]
    if FAIL_DIRECTORY_SYNC.with(|fail| fail.replace(false)) {
        return Err("injected directory sync failure".into());
    }

    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(failure)?;
    let _ = path;
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub last_sequence: i64,
    pub sample_end: u64,
}
impl Default for Manifest {
    fn default() -> Self {
        Self {
            last_sequence: -1,
            sample_end: 0,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub schema: u8,
    pub lease_id: String,
    pub watermark: i64,
    pub sample_end: u64,
    pub finished: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub purged: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stop<'a> {
    schema: u8,
    last_sequence: i64,
    sample_end: u64,
    action: &'a str,
}
struct State {
    manifest: Manifest,
    closed: bool,
    rms: f32,
    quiet_seconds: f64,
}

// Node creates the private lease directory. Published packets are removed only after its durable ingest ACK.
pub struct NativeSpool {
    directory: PathBuf,
    lease: String,
    state: Mutex<State>,
}
impl NativeSpool {
    pub fn bind(root: &Path, lease: &str) -> Result<Self, String> {
        if lease.len() != 64
            || !lease
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("原生音频连接标识无效".into());
        }
        let directory = root.join(lease);
        let metadata = fs::symlink_metadata(&directory).map_err(failure)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || !directory
                .canonicalize()
                .map_err(failure)?
                .starts_with(root.canonicalize().map_err(failure)?)
        {
            return Err("原生音频缓存目录无效".into());
        }
        if directory.join("stop.json").exists() || directory.join("receipt.json").exists() {
            return Err("此音源已开始或结束，请建立新的录音连接".into());
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut marker = options
            .open(directory.join("producer.lock"))
            .map_err(failure)?;
        marker
            .write_all(b"native-pcm-v1\n")
            .and_then(|_| marker.sync_all())
            .map_err(failure)?;
        sync_directory(&directory)?;
        Ok(Self {
            directory,
            lease: lease.into(),
            state: Mutex::new(State {
                manifest: Manifest {
                    last_sequence: -1,
                    sample_end: 0,
                },
                closed: false,
                rms: 0.0,
                quiet_seconds: 0.0,
            }),
        })
    }
    pub fn push(&self, packet: &[u8]) -> Result<(), String> {
        if packet.len() < 14 || packet.len() > MAX_PACKET {
            return Err("原生音频包长度无效".into());
        }
        let sequence = u32::from_le_bytes(packet[0..4].try_into().unwrap());
        let offset = u32::from_le_bytes(packet[4..8].try_into().unwrap());
        let samples = u32::from_le_bytes(packet[8..12].try_into().unwrap());
        if sequence >= 1_000_000
            || !(1..=16000).contains(&samples)
            || packet.len() != 12 + samples as usize * 2
        {
            return Err("原生音频包时序无效".into());
        }
        let mut state = self.state.lock().unwrap();
        if state.closed
            || sequence as i64 != state.manifest.last_sequence + 1
            || offset as u64 != state.manifest.sample_end
        {
            return Err("原生音频序号不连续，缓存已保留".into());
        }
        let receipt = self.receipt(&state.manifest)?;
        if receipt.error.is_some() || receipt.finished {
            return Err("本机录音处理已中断，已保存片段仍保留".into());
        }
        if state.manifest.sample_end.saturating_sub(receipt.sample_end) * 2 + packet.len() as u64
            > MAX_BACKLOG
            || fs2::available_space(&self.directory).map_err(failure)?
                < RESERVE_BYTES + packet.len() as u64
        {
            return Err("本机录音缓存空间不足，采集已停止，已保存片段仍保留".into());
        }
        let mut temporary = tempfile::Builder::new()
            .prefix(".pcm-")
            .tempfile_in(&self.directory)
            .map_err(failure)?;
        temporary
            .write_all(packet)
            .and_then(|_| temporary.write_all(&Sha256::digest(packet)))
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(failure)?;
        let published = temporary
            .persist_noclobber(self.directory.join(format!("{sequence:06}.pcm")))
            .map_err(failure)?;
        // A published packet can already be ingested; its stop fence must include it even if directory sync fails.
        state.manifest = Manifest {
            last_sequence: sequence as i64,
            sample_end: offset as u64 + samples as u64,
        };
        state.rms = (packet[12..]
            .chunks_exact(2)
            .map(|sample| {
                let value = i16::from_le_bytes([sample[0], sample[1]]) as f64 / 32768.0;
                value * value
            })
            .sum::<f64>()
            / samples as f64)
            .sqrt() as f32;
        state.quiet_seconds = if state.rms < 0.0005 {
            state.quiet_seconds + samples as f64 / 16000.0
        } else {
            0.0
        };
        published.sync_all().map_err(failure)?;
        sync_directory(&self.directory)
    }
    fn receipt(&self, manifest: &Manifest) -> Result<Receipt, String> {
        let path = self.directory.join("receipt.json");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Receipt {
                    schema: 1,
                    lease_id: self.lease.clone(),
                    watermark: -1,
                    sample_end: 0,
                    finished: false,
                    error: None, purged:false,
                })
            }
            Err(error) => return Err(failure(error)),
        };
        if !metadata.is_file() || metadata.len() > 4096 {
            return Err("原生音频确认文件无效".into());
        }
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(failure)?
            .take(4097)
            .read_to_end(&mut bytes)
            .map_err(failure)?;
        if bytes.len() > 4096 {
            return Err("原生音频确认文件超过限制".into());
        }
        let receipt: Receipt = serde_json::from_slice(&bytes).map_err(failure)?;
        if receipt.schema != 1
            || receipt.lease_id != self.lease
            || (receipt.purged && (receipt.error.as_deref() != Some("record_expired") || receipt.finished))
            || receipt.watermark < -1
            || receipt.watermark > manifest.last_sequence
            || receipt.sample_end > manifest.sample_end
            || receipt.watermark == -1 && receipt.sample_end != 0
            || receipt.watermark >= 0 && receipt.sample_end == 0
            || receipt.finished
                && (receipt.watermark != manifest.last_sequence
                    || receipt.sample_end != manifest.sample_end)
            || receipt.error.as_ref().is_some_and(|error| {
                error.len() > 80 || !error.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            })
        {
            return Err("原生音频确认不属于此音源，缓存已保留".into());
        }
        Ok(receipt)
    }
    pub fn manifest(&self) -> Manifest { self.state.lock().unwrap().manifest.clone() }
    pub fn progress(&self) -> Result<(Manifest, Receipt, f32, f64), String> {
        let state = self.state.lock().unwrap();
        let receipt = self.receipt(&state.manifest)?;
        if (receipt.finished || receipt.purged) && !state.closed {
            return Err("录音尚未停止，确认清单无效".into());
        }
        Ok((
            state.manifest.clone(),
            receipt,
            state.rms,
            state.quiet_seconds,
        ))
    }
    pub fn control(&self, action: &str) -> Result<(), String> {
        if !["pause", "seal"].contains(&action) { return Err("未知录音停止方式".into()); }
        let state = self.state.lock().unwrap();
        if !state.closed { return Err("请先保存录音尾部".into()); }
        let path = self.directory.join("control.json");
        if path.exists() {
            let mut bytes = Vec::new(); File::open(&path).map_err(failure)?.take(2049).read_to_end(&mut bytes).map_err(failure)?;
            if bytes.len() > 2048 { return Err("录音停止清单无效".into()); }
            let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(failure)?;
            if value["schema"] != 1 || !["pause", "seal"].iter().any(|action| value["action"] == *action) { return Err("录音停止清单无效".into()); }
            if value["action"] == "seal" || value["action"] == action { OpenOptions::new().read(true).write(true).open(&path).and_then(|file|file.sync_all()).map_err(failure)?; return sync_directory(&self.directory); }
        }
        let mut temporary = tempfile::Builder::new().prefix(".control-").tempfile_in(&self.directory).map_err(failure)?;
        temporary.write_all(serde_json::json!({"schema":1,"action":action}).to_string().as_bytes()).and_then(|_| temporary.as_file().sync_all()).map_err(failure)?;
        let saved = temporary.persist(&path).map_err(|error| failure(error.error))?;
        saved.sync_all().map_err(failure)?; sync_directory(&self.directory)
    }
    pub fn close(&self, action: &str) -> Result<Manifest, String> {
        if !["source", "pause", "seal"].contains(&action) {
            return Err("未知录音停止方式".into());
        }
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        let bytes = serde_json::to_vec(&Stop {
            schema: 1,
            last_sequence: state.manifest.last_sequence,
            sample_end: state.manifest.sample_end,
            action,
        })
        .map_err(failure)?;
        let path = self.directory.join("stop.json");
        if path.exists() {
            if fs::read(&path).map_err(failure)? != bytes {
                return Err("录音停止清单已固定".into());
            }
        } else {
            let mut temporary = tempfile::Builder::new()
                .prefix(".stop-")
                .tempfile_in(&self.directory)
                .map_err(failure)?;
            temporary
                .write_all(&bytes)
                .and_then(|_| temporary.as_file().sync_all())
                .map_err(failure)?;
            temporary.persist_noclobber(&path).map_err(failure)?;
        }
        // Flush the published handle too: Windows cannot fsync a directory.
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .and_then(|file| file.sync_all())
            .map_err(failure)?;
        sync_directory(&self.directory)?;
        Ok(state.manifest.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(sequence: u32, offset: u32, samples: u32) -> Vec<u8> {
        [
            sequence.to_le_bytes().as_slice(),
            offset.to_le_bytes().as_slice(),
            samples.to_le_bytes().as_slice(),
            &vec![42; samples as usize * 2],
        ]
        .concat()
    }
    fn fixture() -> (tempfile::TempDir, String) {
        let root = tempfile::tempdir().unwrap();
        let lease = "a".repeat(64);
        fs::create_dir(root.path().join(&lease)).unwrap();
        (root, lease)
    }
    #[test]
    fn published_packets_are_complete_checksummed_private_and_survive_producer_drop() {
        let (root, lease) = fixture();
        let spool = NativeSpool::bind(root.path(), &lease).unwrap();
        let bytes = packet(0, 0, 16000);
        spool.push(&bytes).unwrap();
        spool.push(&packet(1, 16000, 231)).unwrap();
        let manifest = spool.close("pause").unwrap();
        assert_eq!(manifest.last_sequence, 1);
        assert_eq!(manifest.sample_end, 16231);
        assert_eq!(spool.close("pause").unwrap().sample_end, 16231);
        assert!(spool.close("seal").is_err());
        drop(spool);
        let saved = fs::read(root.path().join(&lease).join("000000.pcm")).unwrap();
        assert_eq!(&saved[..bytes.len()], bytes);
        assert_eq!(&saved[bytes.len()..], Sha256::digest(&bytes).as_slice());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.path().join(&lease).join("000000.pcm"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn receipt_must_match_lease_and_produced_fence_without_exposing_pcm() {
        let (root, lease) = fixture();
        let spool = NativeSpool::bind(root.path(), &lease).unwrap();
        spool.push(&packet(0, 0, 16000)).unwrap();
        let mut receipt = Receipt {
            schema: 1,
            lease_id: lease.clone(),
            watermark: 0,
            sample_end: 16000,
            finished: false,
            error: None,
            purged: false,
        };
        let path = root.path().join(&lease).join("receipt.json");
        fs::write(&path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        assert_eq!(spool.progress().unwrap().1.sample_end, 16000);
        receipt.lease_id = "b".repeat(64);
        fs::write(path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        assert!(spool.progress().is_err());
        assert!(root.path().join(&lease).join("000000.pcm").exists());
    }
    #[test]
    fn invalid_order_and_existing_packet_cannot_overwrite_captured_data() {
        let (root, lease) = fixture();
        let spool = NativeSpool::bind(root.path(), &lease).unwrap();
        assert!(spool.push(&packet(1, 0, 16000)).is_err());
        fs::write(root.path().join(&lease).join("000000.pcm"), b"retained").unwrap();
        assert!(spool.push(&packet(0, 0, 16000)).is_err());
        assert_eq!(
            fs::read(root.path().join(&lease).join("000000.pcm")).unwrap(),
            b"retained"
        );
        assert_eq!(spool.progress().unwrap().0.last_sequence, -1);
    }
    #[test]
    fn published_stop_freezes_producer_even_when_directory_sync_fails_and_retry_resyncs() {
        let (root, lease) = fixture();
        let spool = NativeSpool::bind(root.path(), &lease).unwrap();
        spool.push(&packet(0, 0, 16000)).unwrap();
        FAIL_DIRECTORY_SYNC.with(|fail| fail.set(true));
        assert!(spool.close("pause").is_err());
        assert!(root.path().join(&lease).join("stop.json").exists());
        assert!(spool.push(&packet(1, 16000, 16000)).is_err());
        FAIL_DIRECTORY_SYNC.with(|fail| fail.set(true));
        assert!(spool.close("pause").is_err());
        assert_eq!(spool.close("pause").unwrap().last_sequence, 0);
    }
    #[test]
    fn completed_receipt_requires_a_closed_producer_and_exact_stop_fence() {
        let (root, lease) = fixture();
        let spool = NativeSpool::bind(root.path(), &lease).unwrap();
        spool.push(&packet(0, 0, 16000)).unwrap();
        let path = root.path().join(&lease).join("receipt.json");
        let mut receipt = Receipt {
            schema: 1,
            lease_id: lease.clone(),
            watermark: -1,
            sample_end: 16000,
            finished: true,
            error: None,
            purged: false,
        };
        fs::write(&path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        assert!(spool.progress().is_err());
        receipt.watermark = 0;
        fs::write(&path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        assert!(spool.progress().is_err());
        assert!(spool.push(&packet(1, 16000, 16000)).is_err());
        spool.close("source").unwrap();
        assert!(spool.progress().unwrap().1.finished);
    }
    #[test]
    fn closed_or_previously_bound_lease_cannot_be_reopened_for_production() {
        let (root, lease) = fixture();
        let spool = NativeSpool::bind(root.path(), &lease).unwrap();
        assert!(NativeSpool::bind(root.path(), &lease).is_err());
        spool.close("pause").unwrap();
        drop(spool);
        assert!(NativeSpool::bind(root.path(), &lease).is_err());
        assert!(!root.path().join(&lease).join("000000.pcm").exists());
    }
}
