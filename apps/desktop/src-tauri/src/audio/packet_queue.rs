use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Condvar, Mutex};
use super::native_spool::{NativeSpool, Manifest, Receipt};

const MAX_PACKET_BYTES: usize = 12 + 16_000 * 2;

// The UI may be hidden or awaiting IndexedDB. Keep its backlog on a private,
// automatically removed temporary file rather than stopping capture or growing RAM.
pub(super) struct PacketQueue {
    state: Mutex<State>,
    native: Mutex<Option<Arc<NativeSpool>>>,
    native_action: Mutex<String>,
    close_error: Mutex<Option<String>>,
    close_action: Mutex<Option<String>>,
    available: Condvar,
}

pub(super) struct WriterGuard<'a>(&'a PacketQueue);

impl Drop for WriterGuard<'_> {
    fn drop(&mut self) {
        self.0.close();
    }
}

struct State {
    file: File,
    read: u64,
    written: u64,
    closed: bool,
    discarded: bool,
    last_ack: Option<(u32, u32, u32)>,
    produced_samples: u64,
}

fn io_failure(error: std::io::Error) -> String {
    format!("本地音频缓冲读写失败，采集已停止。请检查可用磁盘空间：{error}")
}

impl PacketQueue {
    pub fn new() -> Result<Self, String> {
        Ok(Self::with_file(tempfile::tempfile().map_err(io_failure)?))
    }

    fn with_file(file: File) -> Self {
        Self {
            native: Mutex::new(None), native_action: Mutex::new("source".into()), close_error: Mutex::new(None), close_action: Mutex::new(None),
            state: Mutex::new(State {
                file,
                read: 0,
                written: 0,
                closed: false,
                discarded: false,
                last_ack: None,
                produced_samples: 0,
            }),
            available: Condvar::new(),
        }
    }

    pub fn bind_native(&self, spool: NativeSpool) -> Result<(), String> {
        let state = self.state.lock().unwrap();
        if state.closed || state.written != 0 || self.native.lock().unwrap().is_some() { return Err("此采集连接已经开始".into()); }
        *self.native.lock().unwrap() = Some(Arc::new(spool)); Ok(())
    }
    pub fn direct(&self) -> bool { self.native.lock().unwrap().is_some() }
    pub fn native_manifest(&self) -> Result<Manifest, String> {
        Ok(self.native.lock().unwrap().as_ref().ok_or("此采集不是本机直传")?.manifest())
    }
    pub fn native_progress(&self) -> Result<(Manifest, Receipt, f32, f64), String> {
        self.native.lock().unwrap().as_ref().ok_or("此采集不是本机直传")?.progress()
    }
    pub fn native_action(&self, action: &str) -> Result<(), String> {
        if !["source", "pause", "seal"].contains(&action) { return Err("停止方式无效".into()); }
        { let mut current = self.native_action.lock().unwrap();
          if *current != "seal" && (*current != "pause" || action == "seal") { *current = action.into(); }
        }
        if action != "source" && self.state.lock().unwrap().closed {
            if let Some(spool) = self.native.lock().unwrap().as_ref() { spool.control(action)?; }
        }
        Ok(())
    }
    pub fn action(&self) -> String { self.native_action.lock().unwrap().clone() }
    pub fn wait_closed(&self) -> Result<(), String> {
        let state = self.state.lock().unwrap();
        let (state, _) = self.available.wait_timeout_while(state, std::time::Duration::from_secs(10), |state| !state.closed).unwrap();
        if !state.closed { return Err("录音尾部正在保存，请稍后重试".into()); }
        let error = self.close_error.lock().unwrap().clone();
        if error.is_some() {
            if let Some(spool) = self.native.lock().unwrap().as_ref() {
                let action = self.close_action.lock().unwrap().clone().ok_or("录音停止方式无效")?;
                spool.close(&action)?;
                let desired = self.action(); if desired != "source" { spool.control(&desired)?; }
                *self.close_error.lock().unwrap() = None;
            } else { return Err(error.unwrap()); }
        }
        Ok(())
    }
    pub fn writer(&self) -> WriterGuard<'_> {
        WriterGuard(self)
    }

    pub fn push(&self, packet: &[u8]) -> Result<(), String> {
        if packet.is_empty() || packet.len() > MAX_PACKET_BYTES {
            return Err("本地音频包长度无效，采集已停止".into());
        }
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err("本地音频采集已停止".into());
        }
        if let Some(spool) = self.native.lock().unwrap().as_ref() {
            spool.push(packet)?;
            state.produced_samples = u32::from_le_bytes(packet[4..8].try_into().unwrap()) as u64 + u32::from_le_bytes(packet[8..12].try_into().unwrap()) as u64;
            return Ok(());
        }
        let written = state.written;
        state
            .file
            .seek(SeekFrom::Start(written))
            .map_err(io_failure)?;
        state
            .file
            .write_all(&(packet.len() as u32).to_le_bytes())
            .map_err(io_failure)?;
        state.file.write_all(packet).map_err(io_failure)?;
        // Only complete writes become visible to a reader.
        state.written += 4 + packet.len() as u64;
        if packet.len() >= 14 {
            let offset = u32::from_le_bytes(packet[4..8].try_into().unwrap()) as u64;
            let samples = u32::from_le_bytes(packet[8..12].try_into().unwrap()) as u64;
            if samples > 0 && packet.len() as u64 == 12 + samples * 2 {
                state.produced_samples = state.produced_samples.max(offset + samples);
            }
        }
        self.available.notify_one();
        Ok(())
    }

    pub fn pending(&self) -> Result<Option<Vec<u8>>, String> {
        if self.direct() { return Err("本机直传音频无需通过页面读取".into()); }
        let mut state = self.state.lock().unwrap();
        while state.read == state.written && !state.closed {
            state = self.available.wait(state).unwrap();
        }
        if state.discarded || state.read == state.written {
            return Ok(None);
        }
        let read = state.read;
        state.file.seek(SeekFrom::Start(read)).map_err(io_failure)?;
        let mut length = [0; 4];
        state.file.read_exact(&mut length).map_err(io_failure)?;
        let count = u32::from_le_bytes(length) as usize;
        if count == 0 || count > MAX_PACKET_BYTES || read + 4 + count as u64 > state.written {
            return Err("本地音频缓冲内容损坏，采集已停止".into());
        }
        let mut packet = vec![0; count];
        state.file.read_exact(&mut packet).map_err(io_failure)?;
        Ok(Some(packet))
    }

    pub fn acknowledge(&self, sequence: u32, offset: u32, samples: u32) -> Result<(), String> {
        if self.direct() { return Err("本机直传音频由后台确认".into()); }
        let mut state = self.state.lock().unwrap();
        if samples == 0 || samples > 16_000 { return Err("本地音频确认长度无效".into()); }
        let identity = (sequence, offset, samples);
        if state.last_ack == Some(identity) { return Ok(()); }
        if state.discarded || state.read == state.written { return Err("没有待确认的本地音频包".into()); }
        let read = state.read;
        state.file.seek(SeekFrom::Start(read)).map_err(io_failure)?;
        let mut header = [0u8; 16];
        state.file.read_exact(&mut header).map_err(io_failure)?;
        let count = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
        let actual = (u32::from_le_bytes(header[4..8].try_into().unwrap()), u32::from_le_bytes(header[8..12].try_into().unwrap()), u32::from_le_bytes(header[12..16].try_into().unwrap()));
        if count > MAX_PACKET_BYTES || read + 4 + count as u64 > state.written || count != 12 + samples as usize * 2 || actual != identity { return Err("本地音频确认与待保存包不一致".into()); }
        state.read += 4 + count as u64;
        // Reclaiming consumed space must not suppress the packet just read.
        // If truncation fails, append safely at the existing end; data writes
        // still report real I/O failures through push().
        if state.read == state.written && state.file.set_len(0).is_ok() {
            state.read = 0;
            state.written = 0;
        }
        state.last_ack = Some(identity);
        Ok(())
    }

    pub fn progress(&self) -> (u64, u64, u64) {
        let state = self.state.lock().unwrap();
        if let Some(spool) = self.native.lock().unwrap().as_ref() {
            let end = spool.manifest().sample_end;
            let acknowledged = spool.progress().map(|(_, receipt, _, _)| if receipt.purged {end} else {receipt.sample_end}).unwrap_or(0);
            return (end, acknowledged, end.saturating_sub(acknowledged) * 2);
        }
        let acknowledged = state.last_ack.map(|(_, offset, samples)| offset as u64 + samples as u64).unwrap_or(0);
        (state.produced_samples, acknowledged, state.written - state.read)
    }

    #[cfg(test)]
    pub fn buffered_bytes(&self) -> u64 {
        let state = self.state.lock().unwrap();
        state.written - state.read
    }

    // A normal stop closes the writer after resampling the tail. All queued
    // packets remain readable before EOF; discard explicitly cancels a reader.
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        if state.closed { return; }
        if let Some(spool) = self.native.lock().unwrap().as_ref() {
            let action = self.action(); *self.close_action.lock().unwrap() = Some(action.clone());
            if let Err(error) = spool.close(&action) { *self.close_error.lock().unwrap() = Some(error); }
        }
        state.closed = true;
        drop(state);
        self.available.notify_all();
    }

    pub fn cancel(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.discarded = true;
        self.available.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    fn packet(sequence: u32, samples: u32) -> Vec<u8> {
        [sequence.to_le_bytes().as_slice(), (sequence * 16000).to_le_bytes().as_slice(), samples.to_le_bytes().as_slice(), &vec![42; samples as usize * 2]].concat()
    }
    fn consume(queue: &PacketQueue, sequence: u32, samples: u32) {
        assert_eq!(queue.pending().unwrap().unwrap(), packet(sequence, samples));
        queue.acknowledge(sequence, sequence * 16000, samples).unwrap();
    }
    #[test]
    fn progress_is_independent_of_ack_and_survives_queue_compaction() {
        let queue = PacketQueue::new().unwrap();
        queue.push(&packet(0, 16000)).unwrap();
        queue.push(&packet(1, 4000)).unwrap();
        assert_eq!(queue.progress().0, 20000);
        assert_eq!(queue.progress().1, 0);
        consume(&queue, 0, 16000);
        assert_eq!(queue.progress().0, 20000);
        assert_eq!(queue.progress().1, 16000);
        consume(&queue, 1, 4000);
        assert_eq!(queue.progress(), (20000, 20000, 0));
    }

    #[test]
    fn persistence_failure_keeps_head_and_tail_and_ack_is_idempotent() {
        let queue = PacketQueue::new().unwrap();
        for i in 0..3 { queue.push(&packet(i, 16000)).unwrap(); }
        queue.close();
        assert_eq!(queue.pending().unwrap(), queue.pending().unwrap());
        assert!(queue.acknowledge(1, 16000, 16000).is_err());
        consume(&queue, 0, 16000);
        queue.acknowledge(0, 0, 16000).unwrap();
        consume(&queue, 1, 16000); consume(&queue, 2, 16000);
        assert!(queue.pending().unwrap().is_none());
        assert_eq!(queue.buffered_bytes(), 0);
    }
    #[test]
    fn delayed_reader_retains_three_minutes_and_tail_in_order() {
        let queue = PacketQueue::new().unwrap();
        for i in 0..181 { queue.push(&packet(i, if i==180 {80} else {16000})).unwrap(); }
        queue.close();
        for i in 0..181 { consume(&queue, i, if i==180 {80} else {16000}); }
        assert!(queue.pending().unwrap().is_none());
        assert!(queue.push(&packet(182, 1)).is_err());
    }
    #[test]
    fn independent_lanes_wake_readers_and_reclaim_consumed_disk_space() {
        let lanes: Vec<_>=(0..2).map(|_|Arc::new(PacketQueue::new().unwrap())).collect();
        let readers: Vec<_>=lanes.iter().map(|queue|{let queue=queue.clone();thread::spawn(move||{for i in 0..500 {consume(&queue,i,1);}assert!(queue.pending().unwrap().is_none());})}).collect();
        for i in 0..500 {for queue in &lanes {queue.push(&packet(i,1)).unwrap();}}
        for queue in &lanes {queue.close();}for reader in readers {reader.join().unwrap();}
        for queue in &lanes {assert_eq!(queue.state.lock().unwrap().file.metadata().unwrap().len(),0);}
    }
    #[test]
    fn discard_unblocks_idle_reader_and_rejects_more_audio() {
        let queue=Arc::new(PacketQueue::new().unwrap());
        let reader={let queue=queue.clone();thread::spawn(move||queue.pending().unwrap())};
        queue.cancel();assert!(reader.join().unwrap().is_none());assert!(queue.push(&packet(0,1)).is_err());
        let queued=PacketQueue::new().unwrap();queued.push(&packet(0,1)).unwrap();queued.cancel();assert!(queued.pending().unwrap().is_none());
    }
    #[test]
    fn producer_unwind_closes_queue_and_releases_waiting_reader() {
        let queue=Arc::new(PacketQueue::new().unwrap());
        let worker={let queue=queue.clone();thread::spawn(move||{let _writer=queue.writer();queue.push(&packet(0,1)).unwrap();panic!("synthetic producer failure");})};
        assert!(worker.join().is_err());consume(&queue,0,1);assert!(queue.pending().unwrap().is_none());
    }
    #[test]
    fn io_failure_is_reported_without_publishing_a_partial_packet() {
        let file=tempfile::NamedTempFile::new().unwrap();let queue=PacketQueue::with_file(File::open(file.path()).unwrap());
        assert!(queue.push(&packet(0,1)).unwrap_err().contains("读写失败"));assert_eq!(queue.state.lock().unwrap().written,0);queue.close();assert!(queue.pending().unwrap().is_none());
    }
    #[test]
    fn direct_progress_keeps_published_tail_when_directory_sync_fails() {
        let root=tempfile::tempdir().unwrap(); let lease="a".repeat(64);std::fs::create_dir(root.path().join(&lease)).unwrap();
        let queue=PacketQueue::new().unwrap();queue.bind_native(NativeSpool::bind(root.path(),&lease).unwrap()).unwrap();
        super::super::native_spool::fail_next_directory_sync();
        assert!(queue.push(&packet(0,16000)).is_err());
        assert_eq!(queue.progress().0,16000);assert_eq!(queue.native_progress().unwrap().0.sample_end,16000);
        queue.close();queue.wait_closed().unwrap();assert!(root.path().join(&lease).join("000000.pcm").exists());
    }
    #[test]
    fn direct_stop_can_retry_its_immutable_manifest_after_io_recovers() {
        let root=tempfile::tempdir().unwrap();let lease="b".repeat(64);std::fs::create_dir(root.path().join(&lease)).unwrap();
        let queue=PacketQueue::new().unwrap();queue.bind_native(NativeSpool::bind(root.path(),&lease).unwrap()).unwrap();queue.push(&packet(0,79)).unwrap();
        super::super::native_spool::fail_next_directory_sync();queue.close();assert!(queue.close_error.lock().unwrap().is_some());
        super::super::native_spool::fail_next_directory_sync();assert!(queue.wait_closed().is_err());
        queue.wait_closed().unwrap();assert!(queue.close_error.lock().unwrap().is_none());
        assert_eq!(queue.native_progress().unwrap().0.sample_end,79);assert!(root.path().join(&lease).join("000000.pcm").exists());
    }

}
