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

    pub fn read(&self) -> Result<Option<Vec<u8>>, String> {
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
        state.read += 4 + count as u64;
        // Reclaiming consumed space must not suppress the packet just read.
        // If truncation fails, append safely at the existing end; data writes
        // still report real I/O failures through push().
        if state.read == state.written && state.file.set_len(0).is_ok() {
            state.read = 0;
            state.written = 0;
        }
        Ok(Some(packet))
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

    #[test]
    fn delayed_reader_retains_three_minutes_and_tail_in_order() {
        let queue = PacketQueue::new().unwrap();
        for i in 0..181u32 {
            let mut packet = vec![i as u8; if i == 180 { 172 } else { MAX_PACKET_BYTES }];
            packet[..4].copy_from_slice(&i.to_le_bytes());
            queue.push(&packet).unwrap();
        }
        queue.close();
        for i in 0..181u32 {
            let packet = queue.read().unwrap().unwrap();
            assert_eq!(u32::from_le_bytes(packet[..4].try_into().unwrap()), i);
            assert_eq!(packet.len(), if i == 180 { 172 } else { MAX_PACKET_BYTES });
            assert!(packet[4..].iter().all(|&value| value == i as u8));
        }
        assert!(queue.read().unwrap().is_none());
        assert!(queue.push(&[1]).is_err());
    }

    #[test]
    fn independent_lanes_wake_readers_and_reclaim_consumed_disk_space() {
        let lanes: Vec<_> = (0..2)
            .map(|_| Arc::new(PacketQueue::new().unwrap()))
            .collect();
        let readers: Vec<_> = lanes
            .iter()
            .enumerate()
            .map(|(lane, queue)| {
                let queue = queue.clone();
                thread::spawn(move || {
                    for i in 0..500u32 {
                        assert_eq!(
                            queue.read().unwrap().unwrap(),
                            [i.to_le_bytes().as_slice(), &[lane as u8]].concat()
                        );
                    }
                    assert!(queue.read().unwrap().is_none());
                })
            })
            .collect();
        for i in 0..500u32 {
            for (lane, queue) in lanes.iter().enumerate() {
                queue
                    .push(&[i.to_le_bytes().as_slice(), &[lane as u8]].concat())
                    .unwrap();
            }
        }
        for queue in &lanes {
            queue.close();
        }
        for reader in readers {
            reader.join().unwrap();
        }
        for queue in &lanes {
            assert_eq!(
                queue.state.lock().unwrap().file.metadata().unwrap().len(),
                0
            );
        }
    }

    #[test]
    fn discard_unblocks_idle_reader_and_rejects_more_audio() {
        let queue = Arc::new(PacketQueue::new().unwrap());
        let reader = {
            let queue = queue.clone();
            thread::spawn(move || queue.read().unwrap())
        };
        queue.cancel();
        assert!(reader.join().unwrap().is_none());
        assert!(queue.push(&[1]).is_err());
        let queued = PacketQueue::new().unwrap();
        queued.push(&[1]).unwrap();
        queued.cancel();
        assert!(queued.read().unwrap().is_none());
    }

    #[test]
    fn producer_unwind_closes_queue_and_releases_waiting_reader() {
        let queue = Arc::new(PacketQueue::new().unwrap());
        let worker = {
            let queue = queue.clone();
            thread::spawn(move || {
                let _writer = queue.writer();
                queue.push(&[42]).unwrap();
                panic!("synthetic producer failure");
            })
        };
        assert!(worker.join().is_err());
        assert_eq!(queue.read().unwrap(), Some(vec![42]));
        assert!(queue.read().unwrap().is_none());
    }

    #[test]
    fn io_failure_is_reported_without_publishing_a_partial_packet() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let queue = PacketQueue::with_file(File::open(file.path()).unwrap());
        let error = queue.push(&[1; 32]).unwrap_err();
        assert!(error.contains("读写失败"));
        assert_eq!(queue.state.lock().unwrap().written, 0);
        queue.close();
        assert!(queue.read().unwrap().is_none());
    }
}
