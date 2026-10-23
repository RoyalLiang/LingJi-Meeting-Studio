mod packet_queue;
use packet_queue::PacketQueue;
pub mod pipeline;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample};
use pipeline::Pipeline;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::{self, Receiver, SyncSender},
    Arc, Mutex,
};
use std::time::Duration;

#[derive(Serialize)]
pub struct Input {
    pub id: String,
    pub label: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}
#[derive(Serialize)]
pub struct Started {
    pub id: String,
    pub label: String,
}
struct Capture {
    kind: String,
    stop: Arc<AtomicBool>,
    discard: Arc<AtomicBool>,
    receiver: Arc<PacketQueue>,
    error: Arc<Mutex<Option<String>>>,
}
#[derive(Default)]
pub struct Captures {
    sessions: Mutex<HashMap<String, Arc<Capture>>>,
    next: AtomicU64,
}

fn audio_host(system: bool) -> Result<cpal::Host, String> {
    #[cfg(target_os = "linux")]
    {
        if cpal::available_hosts().contains(&cpal::HostId::PipeWire) {
            return cpal::host_from_id(cpal::HostId::PipeWire)
                .map_err(|e| format!("PipeWire 不可用：{e}"));
        }
        if system {
            return Err("系统音频需要正在运行的 PipeWire。请启动 PipeWire，或显式选择麦克风；不会自动改用麦克风。".into());
        }
    }
    let _ = system;
    Ok(cpal::default_host())
}

fn default_microphone_id(devices: &[Input]) -> Result<Option<&str>, String> {
    fn loopback(label: &str) -> bool {
        let label = label.to_lowercase();
        [
            "system audio",
            "blackhole",
            "loopback",
            "soundflower",
            "virtual",
            "vb-cable",
            "vb cable",
            "background music",
            "monitor",
            "虚拟",
            "回环",
        ]
        .iter()
        .any(|word| label.contains(word))
            || ((label.contains("zoom") || label.contains("teams")) && label.contains("audio"))
    }
    let Some(current) = devices.iter().find(|device| device.is_default) else {
        return Ok(None);
    };
    if !loopback(&current.label) {
        return Ok(None);
    }
    let physical = devices.iter().find(|device| {
        let label = device.label.to_lowercase();
        !loopback(&label)
            && [
                "microphone",
                "麦克风",
                "built-in",
                "built in",
                "内建",
                "内置",
                "airpods",
                "headset",
                "耳机",
            ]
            .iter()
            .any(|word| label.contains(word))
    });
    physical
        .map(|device| Some(device.id.as_str()))
        .ok_or_else(|| {
            "默认输入是虚拟音源，尚未找到可识别的实体麦克风。请在设置中显式选择音源。".into()
        })
}

fn microphone_id<'a>(
    selected: Option<&'a str>,
    devices: &'a [Input],
) -> Result<Option<&'a str>, String> {
    match selected.filter(|id| *id != "default" && devices.iter().any(|device| device.id == *id)) {
        Some(id) => Ok(Some(id)),
        None => default_microphone_id(devices),
    }
}

pub fn inputs() -> Result<Vec<Input>, String> {
    input_list(&audio_host(false)?)
}

fn input_list(host: &cpal::Host) -> Result<Vec<Input>, String> {
    let default = host.default_input_device().and_then(|d| d.id().ok());
    host.input_devices()
        .map_err(|e| e.to_string())?
        .map(|device| {
            let id = device.id().map_err(|e| e.to_string())?;
            Ok(Input {
                is_default: Some(&id) == default.as_ref(),
                id: id.to_string(),
                label: device
                    .description()
                    .map_err(|e| e.to_string())?
                    .name()
                    .to_string(),
            })
        })
        .collect()
}

// Keep a bounded queue while the processor catches up from a short CPU or disk stall.
fn raw_input_channel() -> (SyncSender<Vec<f32>>, Receiver<Vec<f32>>) {
    mpsc::sync_channel(256)
}

fn queue_input<T>(sender: &SyncSender<Vec<f32>>, data: &[T], error: &Mutex<Option<String>>, stop: &AtomicBool)
where T: cpal::SizedSample, f32: FromSample<T> {
    if stop.load(Ordering::Relaxed) { return; }
    if data.len() > 65_536 || sender.try_send(data.iter().map(|x| f32::from_sample(*x)).collect()).is_err() {
        *error.lock().unwrap() = Some("原生音频处理积压，已停止采集。请检查设备性能与本地存储，避免继续丢失音频。".into());
        stop.store(true, Ordering::Release);
    }
}

fn input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sender: SyncSender<Vec<f32>>,
    error: Arc<Mutex<Option<String>>>,
    stop: Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
{
    let failure = error.clone();
    let failed = stop.clone();
    device.build_input_stream(*config, move |data: &[T], _| { queue_input(&sender, data, &error, &stop); }, move |e| { *failure.lock().unwrap() = Some(format!("音频设备停止：{e}")); failed.store(true, Ordering::Release); }, None)
        .map_err(|e| e.to_string())
}

fn send_packets(sender: &PacketQueue, packets: Vec<Vec<u8>>) -> Result<(), String> {
    for packet in packets { sender.push(&packet)?; }
    Ok(())
}

impl Captures {
    pub fn active(&self) -> bool {
        !self.sessions.lock().unwrap().is_empty()
    }
    #[cfg(feature = "smoke-test")]
    pub fn synthetic(&self, kind: &str) -> Result<Started, String> {
        let id = format!("fixture-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let stop = Arc::new(AtomicBool::new(false));
        let discard = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        let packets = Arc::new(PacketQueue::new()?);
        let receiver = packets.clone();
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.values().any(|s| s.kind == kind) {
            return Err("此合成音源已接入".into());
        }
        sessions.insert(
            id.clone(),
            Arc::new(Capture {
                kind: kind.into(),
                stop: stop.clone(),
                discard: discard.clone(),
                receiver,
                error: error.clone(),
            }),
        );
        std::thread::spawn(move || {
            let _writer = packets.writer();
            let result = (|| {
                let mut pipe = Pipeline::new(48_000, 2)?;
                let mut offset = 0;
                while !stop.load(Ordering::Acquire) {
                    let data: Vec<f32> = (0..960)
                        .flat_map(|n| {
                            let v = ((offset + n) as f32 * 440.0 * std::f32::consts::TAU
                                / 48_000.0)
                                .sin()
                                * 0.25;
                            [v, v]
                        })
                        .collect();
                    send_packets(&packets, pipe.push(&data)?)?;
                    offset += 960;
                    std::thread::sleep(Duration::from_millis(20));
                }
                if !discard.load(Ordering::Acquire) {
                    send_packets(&packets, pipe.finish()?)?;
                }
                Ok::<(), String>(())
            })();
            if let Err(e) = result {
                *error.lock().unwrap() = Some(e);
            }
        });
        Ok(Started {
            id,
            label: "合成音源 · 不采集真实设备".into(),
        })
    }
    pub fn start(&self, kind: &str, selected: Option<&str>) -> Result<Started, String> {
        if !["display", "microphone"].contains(&kind) {
            return Err("未知音源".into());
        }
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.values().any(|s| s.kind == kind) {
            return Err("此音源已接入".into());
        }
        let id = format!("native-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let stop = Arc::new(AtomicBool::new(false));
        let discard = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        let packets = Arc::new(PacketQueue::new()?);
        let receiver = packets.clone();
        let (ready, started) = mpsc::sync_channel(1);
        sessions.insert(
            id.clone(),
            Arc::new(Capture {
                kind: kind.into(),
                stop: stop.clone(),
                discard: discard.clone(),
                receiver,
                error: error.clone(),
            }),
        );
        drop(sessions);
        let (worker_stop, worker_discard, worker_error) =
            (stop.clone(), discard.clone(), error.clone());
        let worker_kind = kind.to_string();
        let selected = selected.map(str::to_string);
        std::thread::spawn(move || {
            let _writer = packets.writer();
            let result = (|| {
                let host = audio_host(worker_kind == "display")?;
                let devices = if worker_kind == "microphone" {
                    input_list(&host)?
                } else {
                    Vec::new()
                };
                let selected = microphone_id(selected.as_deref(), &devices)?;
                let device = if worker_kind == "display" {
                    host.default_output_device()
                } else if let Some(id) = selected {
                    let id = id.parse().map_err(|_| "音频设备标识无效")?;
                    host.device_by_id(&id)
                } else {
                    host.default_input_device()
                }
                .ok_or("所选音频设备不可用，请重新选择")?;
                let config = if worker_kind == "display" {
                    device.default_output_config()
                } else {
                    device.default_input_config()
                }
                .map_err(|e| e.to_string())?;
                let mut pipeline = Pipeline::new(config.sample_rate(), config.channels() as usize)?;
                let (raw, frames) = raw_input_channel();
                let stream_config = config.config();
                let stream = match config.sample_format() {
                    cpal::SampleFormat::F32 => input_stream::<f32>(
                        &device,
                        &stream_config,
                        raw,
                        worker_error.clone(),
                        worker_stop.clone(),
                    ),
                    cpal::SampleFormat::I16 => input_stream::<i16>(
                        &device,
                        &stream_config,
                        raw,
                        worker_error.clone(),
                        worker_stop.clone(),
                    ),
                    cpal::SampleFormat::U16 => input_stream::<u16>(
                        &device,
                        &stream_config,
                        raw,
                        worker_error.clone(),
                        worker_stop.clone(),
                    ),
                    format => Err(format!("尚未支持设备格式 {format}")),
                }?;
                if worker_stop.load(Ordering::Acquire) {
                    return Err("采集启动已取消".into());
                }
                stream.play().map_err(|e| e.to_string())?;
                let label = device
                    .description()
                    .map_err(|e| e.to_string())?
                    .name()
                    .to_string();
                ready.send(Ok(label)).map_err(|_| "采集启动已取消")?;
                while !worker_stop.load(Ordering::Acquire) {
                    match frames.recv_timeout(Duration::from_millis(200)) {
                        Ok(data) => send_packets(&packets, pipeline.push(&data)?)?,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => break,
                    }
                }
                drop(stream);
                if !worker_discard.load(Ordering::Acquire) && worker_error.lock().unwrap().is_none()
                {
                    for data in frames.try_iter() {
                        send_packets(&packets, pipeline.push(&data)?)?;
                    }
                    send_packets(&packets, pipeline.finish()?)?;
                }
                Ok::<(), String>(())
            })();
            if let Err(message) = result {
                *worker_error.lock().unwrap() = Some(message.clone());
                let _ = ready.send(Err(message));
            }
        });
        let result = started.recv_timeout(Duration::from_secs(30));
        let label = match result {
            Ok(Ok(label)) => label,
            result => {
                stop.store(true, Ordering::Release);
                self.sessions.lock().unwrap().remove(&id);
                return Err(match result {
                    Ok(Err(e)) => e,
                    _ => "音频设备启动超时，请检查系统权限".into(),
                });
            }
        };
        Ok(Started { id, label })
    }

    pub fn read(&self, id: &str) -> Result<Vec<u8>, String> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("采集已结束")?;
        // WASAPI/PipeWire may provide no packets while the output is idle. An idle output is not a failed device.
        let result = session.receiver.read();
        match result {
            Ok(Some(bytes)) => Ok(bytes),
            result => {
                session.stop.store(true, Ordering::Release);
                session.receiver.cancel();
                self.sessions.lock().unwrap().remove(id);
                if let Err(error) = result { return Err(error); }
                if let Some(error) = session.error.lock().unwrap().take() {
                    Err(error)
                } else {
                    Ok(Vec::new())
                }
            }
        }
    }

    pub fn stop(&self, id: &str, discard: bool) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get(id) {
            session.discard.store(discard, Ordering::Release);
            session.stop.store(true, Ordering::Release);
            if discard { session.receiver.cancel(); }
        }
        if discard {
            sessions.remove(id);
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        for session in self.sessions.lock().unwrap().values() {
            session.discard.store(true, Ordering::Release);
            session.stop.store(true, Ordering::Release);
            session.receiver.cancel();
        }
    }
}

impl Drop for Captures {
    fn drop(&mut self) {
        self.stop_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn short_input_stall_retains_ordered_audio_without_stopping_capture() {
        let (sender, receiver) = raw_input_channel();
        let stop = AtomicBool::new(false);
        let error = Mutex::new(None);
        // 96 callbacks of 128 stereo frames represent 256 ms at 48 kHz.
        for index in 0..96 {
            queue_input(&sender, &vec![index as f32; 256], &error, &stop);
        }
        assert!(!stop.load(Ordering::Acquire), "a brief stall must not end a long recording");
        assert!(error.lock().unwrap().is_none());
        drop(sender);
        let blocks: Vec<_> = receiver.into_iter().collect();
        assert_eq!(blocks.len(), 96);
        for (index, block) in blocks.iter().enumerate() {
            assert_eq!(block, &vec![index as f32; 256]);
        }
    }

    #[test]
    fn prolonged_input_stall_stops_explicitly_with_a_bounded_queue() {
        let (sender, receiver) = raw_input_channel();
        let stop = AtomicBool::new(false);
        let error = Mutex::new(None);
        for index in 0..257 {
            queue_input(&sender, &[index as f32], &error, &stop);
        }
        assert!(stop.load(Ordering::Acquire));
        assert!(error.lock().unwrap().as_ref().unwrap().contains("已停止采集"));
        assert_eq!(receiver.try_iter().collect::<Vec<_>>(), (0..256).map(|i| vec![i as f32]).collect::<Vec<_>>());
    }

    #[test]
    fn frontend_delay_preserves_all_audio_instead_of_stopping_at_ninth_packet() {
        let packets = PacketQueue::new().unwrap();
        let expected: Vec<Vec<u8>> = (0..180).map(|i| vec![i; 32_012]).collect();
        send_packets(&packets, expected.clone()).unwrap();
        packets.close();
        for packet in expected {
            assert_eq!(packets.read().unwrap(), Some(packet));
        }
        assert!(packets.read().unwrap().is_none());
    }
    #[cfg(feature = "smoke-test")]
    #[test]
    fn native_capture_survives_delayed_frontend_reads_and_drains_on_stop() {
        let captures = Captures::default();
        let started = captures.synthetic("display").unwrap();
        let session = captures.sessions.lock().unwrap()[&started.id].clone();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while session.receiver.buffered_bytes() < 10 * (32_012 + 4) {
            assert!(session.error.lock().unwrap().is_none());
            assert!(std::time::Instant::now() < deadline, "synthetic producer did not progress");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(captures.active());
        assert!(session.error.lock().unwrap().is_none());
        captures.stop(&started.id, false).unwrap();
        let (mut sequence, mut offset) = (0u32, 0u32);
        loop {
            let packet = captures.read(&started.id).unwrap();
            if packet.is_empty() { break; }
            let field = |at| u32::from_le_bytes(packet[at..at + 4].try_into().unwrap());
            assert_eq!(field(0), sequence);
            assert_eq!(field(4), offset);
            assert_eq!(packet.len(), 12 + field(8) as usize * 2);
            sequence += 1;
            offset += field(8);
        }
        assert!(offset >= 9 * pipeline::RATE, "must preserve audio beyond the old eight-packet limit");
        assert!(!captures.active());
    }

    #[test]
    fn automatic_microphone_avoids_virtual_defaults_and_requires_explicit_unknown_input() {
        let mut devices = vec![Input {
            id: "virtual".into(),
            label: "BlackHole 2ch".into(),
            is_default: true,
        }];
        assert!(default_microphone_id(&devices).is_err());
        devices.push(Input {
            id: "physical".into(),
            label: "Built-in Microphone".into(),
            is_default: false,
        });
        assert_eq!(default_microphone_id(&devices).unwrap(), Some("physical"));
        devices[0].label = "USB Microphone".into();
        assert_eq!(default_microphone_id(&devices).unwrap(), None);
    }

    #[test]
    fn missing_saved_microphone_uses_the_current_default_input() {
        let devices = vec![Input {
            id: "current".into(),
            label: "USB Microphone".into(),
            is_default: true,
        }];
        assert_eq!(microphone_id(Some("removed"), &devices).unwrap(), None);
        assert_eq!(microphone_id(Some("default"), &devices).unwrap(), None);
        assert_eq!(microphone_id(None, &devices).unwrap(), None);
    }

    #[test]
    fn missing_saved_microphone_keeps_automatic_virtual_input_protection() {
        let mut devices = vec![Input {
            id: "virtual".into(),
            label: "BlackHole 2ch".into(),
            is_default: true,
        }];
        assert_eq!(
            microphone_id(Some("removed"), &devices).unwrap_err(),
            default_microphone_id(&devices).unwrap_err()
        );
        devices.push(Input {
            id: "physical".into(),
            label: "Built-in Microphone".into(),
            is_default: false,
        });
        assert_eq!(
            microphone_id(Some("removed"), &devices).unwrap(),
            Some("physical")
        );
    }

    #[test]
    fn available_explicit_microphone_is_preserved_including_virtual_inputs() {
        let mut devices = vec![Input {
            id: "virtual".into(),
            label: "BlackHole 2ch".into(),
            is_default: true,
        }];
        assert_eq!(
            microphone_id(Some("virtual"), &devices).unwrap(),
            Some("virtual")
        );
        devices.push(Input {
            id: "selected".into(),
            label: "USB Microphone".into(),
            is_default: false,
        });
        assert_eq!(
            microphone_id(Some("selected"), &devices).unwrap(),
            Some("selected")
        );
    }
}
