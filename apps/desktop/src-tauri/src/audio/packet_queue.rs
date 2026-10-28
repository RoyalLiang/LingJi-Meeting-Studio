use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{Condvar, Mutex};

const MAX_PACKET_BYTES: usize = 12 + 16_000 * 2;

// The UI may be hidden or awaiting IndexedDB. Keep its backlog on a private,
// automatically removed temporary file rather than stopping capture or growing RAM.
pub(super) struct PacketQueue {
    state: Mutex<State>,
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
            state: Mutex::new(State {
                file,
                read: 0,
                written: 0,
                closed: false,
                discarded: false,
                last_ack: None,
            }),
            available: Condvar::new(),
        }
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
        self.available.notify_one();
        Ok(())
    }

    pub fn pending(&self) -> Result<Option<Vec<u8>>, String> {
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

    #[cfg(test)]
    pub fn buffered_bytes(&self) -> u64 {
        let state = self.state.lock().unwrap();
        state.written - state.read
    }

    // A normal stop closes the writer after resampling the tail. All queued
    // packets remain readable before EOF; discard explicitly cancels a reader.
    pub fn close(&self) {
        self.state.lock().unwrap().closed = true;
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
}
