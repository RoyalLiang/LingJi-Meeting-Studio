pub mod applications;
mod dsp;
mod native_spool;
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
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub sample_end: u64,
    pub acknowledged_sample_end: u64,
    pub buffered_bytes: u64,
}

struct Capture {
    kind: String,
    stop: Arc<AtomicBool>,
    discard: Arc<AtomicBool>,
    receiver: Arc<PacketQueue>,
    armed: Arc<AtomicBool>,
    processing: Arc<Mutex<Option<dsp::Processor>>>,
    binding: Mutex<Option<serde_json::Value>>,
    native_pending: AtomicBool,
    native_bound: AtomicBool,
    native_purged: AtomicBool,
    user_disabled: AtomicBool,
    error: Arc<Mutex<Option<String>>>,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatus {
    pub record_id: String, pub recording: bool, pub microphone_on: bool, pub paused: bool,
    pub can_resume: bool, pub duration_ms: u64, pub rms: f64, pub pending_count: u64,
}
#[derive(Default)]
pub struct Captures {
    sessions: Mutex<HashMap<String, Arc<Capture>>>,
    next: AtomicU64,
    intents: Mutex<HashMap<(String,String), bool>>,
}

fn native_timeline_end(source: &serde_json::Value, samples: u64) -> u64 {
    let base = source["timelineOffsetMs"].as_f64().filter(|value|value.is_finite() && *value >= 0.0).unwrap_or(0.0);
    (base + samples as f64 / 16.0).ceil() as u64
}
enum CaptureStream {
    Device {stream:cpal::Stream,#[cfg(target_os="macos")] application:Option<applications::macos::Tap>},
    #[cfg(target_os="windows")]
    Application(applications::windows::Capture),
}
impl CaptureStream {
    fn play(&self)->Result<(),String>{match self {Self::Device{stream,..}=>stream.play().map_err(|e|e.to_string()),#[cfg(target_os="windows")]Self::Application(_)=>Ok(())}}
    fn check(&mut self)->Result<(),String>{match self {Self::Device{#[cfg(target_os="macos")]application,..}=>{#[cfg(target_os="macos")]if let Some(tap)=application{tap.refresh()?;}Ok(())},#[cfg(target_os="windows")]Self::Application(stream)=>stream.check()}}
}

fn audio_host(system: bool) -> Result<cpal::Host, String> {
    #[cfg(target_os = "linux")]
    {
        if cpal::available_hosts().contains(&cpal::HostId::PulseAudio) {
            return cpal::host_from_id(cpal::HostId::PulseAudio)
                .map_err(|e| format!("PulseAudio / PipeWire Pulse 不可用：{e}"));
        }
        if system {
            return Err("系统音频需要正在运行的 PulseAudio 或 PipeWire Pulse 服务。请启动音频服务，或显式选择麦克风；不会自动改用麦克风。".into());
        }
    }
    let _ = system;
    Ok(cpal::default_host())
}

#[cfg(target_os = "linux")]
fn system_device(host: &cpal::Host) -> Result<cpal::Device, String> {
    // Use the server's actual monitor source rather than guessing its name.
    let output = host.default_output_device().ok_or("默认输出设备不可用")?;
    let sink = output.id().map_err(|e| e.to_string())?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = (|| {
            let name = std::ffi::CString::new("Lingji system capture").unwrap();
            let client = pulseaudio::Client::from_env(name).map_err(|e| e.to_string())?;
            let sink = std::ffi::CString::new(sink.id()).map_err(|e| e.to_string())?;
            let info = futures::executor::block_on(client.sink_info_by_name(sink))
                .map_err(|e| e.to_string())?;
            info.monitor_source_name.ok_or("默认输出没有监视音源".to_string())?
                .into_string().map_err(|e| e.to_string())
        })();
        let _ = sender.send(result);
    });
    let monitor = receiver.recv_timeout(Duration::from_secs(3))
        .map_err(|e| format!("查询系统音频超时或失败：{e}"))??;
    host.device_by_id(&cpal::DeviceId::new(cpal::HostId::PulseAudio, monitor))
        .ok_or("默认输出的监视音源不可用；不会自动改用麦克风".into())
}

#[cfg(not(target_os = "linux"))]
fn system_device(host: &cpal::Host) -> Result<cpal::Device, String> {
    host.default_output_device().ok_or("默认输出设备不可用".into())
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

fn handle_stream_error(event: cpal::Error, error: &Mutex<Option<String>>, stop: &AtomicBool, warned: &AtomicBool, rebuild: &AtomicBool) {
    if matches!(event.kind(), cpal::ErrorKind::StreamInvalidated | cpal::ErrorKind::DeviceNotAvailable) {
        rebuild.store(true, Ordering::Release);
        return;
    }
    // CPAL keeps the stream running for these notifications and still delivers audio.
    if matches!(event.kind(), cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::RealtimeDenied) {
        if !warned.swap(true, Ordering::Relaxed) {
            eprintln!("[lingji-audio-warning] {event}；采集继续，缓冲波动可能造成短暂音频缺口。");
        }
        return;
    }
    *error.lock().unwrap() = Some(format!("音频设备停止：{event}"));
    stop.store(true, Ordering::Release);
}

fn input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sender: SyncSender<Vec<f32>>,
    error: Arc<Mutex<Option<String>>>,
    stop: Arc<AtomicBool>,
    rebuild: Arc<AtomicBool>,
    armed: Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
{
    let failure = error.clone();
    let failed = stop.clone();
    let warned = AtomicBool::new(false);
    device.build_input_stream(*config, move |data: &[T], _| { if !armed.load(Ordering::Acquire) { return; } queue_input(&sender, data, &error, &stop); }, move |e| { handle_stream_error(e, &failure, &failed, &warned, &rebuild); }, None)
        .map_err(|e| e.to_string())
}

fn send_packets(sender: &PacketQueue, packets: Vec<Vec<u8>>) -> Result<(), String> {
    for packet in packets { sender.push(&packet)?; }
    Ok(())
}

fn finish_capture(packets: &PacketQueue, mut pipeline: Pipeline, frames: Receiver<Vec<f32>>, discard: bool) -> Result<(), String> {
    if !discard {
        for data in frames.try_iter() { send_packets(packets, pipeline.push(&data)?)?; }
        send_packets(packets, pipeline.finish()?)?;
    }
    Ok(())
}

fn prepare_restart(sender: &PacketQueue, pipeline: &mut Pipeline, frames: Receiver<Vec<f32>>, attempts: usize) -> Result<(),String> {
    for data in frames.try_iter() { send_packets(sender,pipeline.push(&data)?)?; }
    send_packets(sender,pipeline.flush()?)?;
    if attempts>=3 { return Err("音频设备连续切换失败，请重新选择设备".into()); }
    Ok(())
}

impl Captures {
    pub fn active(&self) -> bool {
        self.sessions.try_lock().map_or(true, |sessions| sessions.values().any(|session| {
            !session.native_bound.load(Ordering::Acquire) || !session.stop.load(Ordering::Acquire) || session.native_pending.load(Ordering::Acquire)
        }))
    }
    #[cfg(feature = "smoke-test")]
    pub fn synthetic(&self, kind: &str) -> Result<Started, String> {
        self.synthetic_source(kind, None)
    }

    #[cfg(feature = "smoke-test")]
    fn synthetic_source(&self, kind: &str, frame_limit: Option<(usize, mpsc::SyncSender<()>)>) -> Result<Started, String> {
        self.synthetic_source_mode(kind, frame_limit, true)
    }
    #[cfg(feature = "smoke-test")]
    pub fn prepare_synthetic(&self, kind: &str) -> Result<Started, String> { self.synthetic_source_mode(kind, None, false) }
    #[cfg(feature = "smoke-test")]
    fn synthetic_source_mode(&self, kind: &str, frame_limit: Option<(usize, mpsc::SyncSender<()>)>, armed_initially: bool) -> Result<Started, String> {
        let id = format!("fixture-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let stop = Arc::new(AtomicBool::new(false));
        let discard = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        let packets = Arc::new(PacketQueue::new()?);
        let receiver = packets.clone();
        let armed = Arc::new(AtomicBool::new(armed_initially));
        let processing=Arc::new(Mutex::new(None));
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.values().any(|s| s.kind == kind && !s.stop.load(Ordering::Acquire)) {
            return Err("此合成音源已接入".into());
        }
        sessions.insert(
            id.clone(),
            Arc::new(Capture {
                kind: kind.into(),
                stop: stop.clone(),
                discard: discard.clone(),
                receiver,
                processing: processing.clone(), armed: armed.clone(), binding: Mutex::new(None), native_pending: AtomicBool::new(false), native_bound: AtomicBool::new(false), native_purged: AtomicBool::new(false), user_disabled: AtomicBool::new(false),
                error: error.clone(),
            }),
        );
        std::thread::spawn(move || {
            let _writer = packets.writer();
            let result = (|| {
                let mut pipe = Pipeline::new(48_000, 2)?;
                let mut offset = 0;
                let mut frames = 0;
                while !stop.load(Ordering::Acquire) && frame_limit.as_ref().is_none_or(|(limit, _)| frames < *limit) {
                    if !armed.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(10)); continue; }
                    pipe.set_processing(processing.lock().unwrap().take());
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
                    frames += 1;
                    if frame_limit.is_none() { std::thread::sleep(Duration::from_millis(20)); }
                }
                if let Some((_, ready)) = frame_limit {
                    ready.send(()).map_err(|_| "合成测试调用已结束")?;
                    // The test controls stop explicitly so the real stop path must flush the tail.
                    while !stop.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(1)); }
                }
                if !discard.load(Ordering::Acquire) {
                    send_packets(&packets, pipe.finish()?)?;
                }
                Ok::<(), String>(())
            })();
            if let Err(e) = result {
                stop.store(true, Ordering::Release);
                *error.lock().unwrap() = Some(e);
            }
        });
        Ok(Started {
            id,
            label: "合成音源 · 不采集真实设备".into(),
        })
    }
    pub fn start(&self, kind: &str, selected: Option<&str>) -> Result<Started, String> { self.start_mode(kind, selected, true) }
    pub fn prepare(&self, kind: &str, selected: Option<&str>) -> Result<Started, String> { self.start_mode(kind, selected, false) }
    fn start_mode(&self, kind: &str, selected: Option<&str>, armed_initially: bool) -> Result<Started, String> {
        if !["display", "microphone"].contains(&kind) {
            return Err("未知音源".into());
        }
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.values().any(|s| s.kind == kind && !s.stop.load(Ordering::Acquire)) {
            return Err("此音源已接入".into());
        }
        let id = format!("native-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let stop = Arc::new(AtomicBool::new(false));
        let discard = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        let packets = Arc::new(PacketQueue::new()?);
        let receiver = packets.clone();
        let armed = Arc::new(AtomicBool::new(armed_initially));
        let processing=Arc::new(Mutex::new(None));
        let (ready, started) = mpsc::sync_channel(1);
        sessions.insert(
            id.clone(),
            Arc::new(Capture {
                kind: kind.into(),
                stop: stop.clone(),
                discard: discard.clone(),
                receiver,
                processing: processing.clone(), armed: armed.clone(), binding: Mutex::new(None), native_pending: AtomicBool::new(false), native_bound: AtomicBool::new(false), native_purged: AtomicBool::new(false), user_disabled: AtomicBool::new(false),
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
                let mut retained: Option<Pipeline> = None;
                let mut announced = Some(ready.clone());
                let mut restarts = 0;
                let mut stable_since = std::time::Instant::now();
                loop {
                let rebuild = Arc::new(AtomicBool::new(false));
                let opened = (|| {
                let application_target=if worker_kind=="display" {selected.as_deref().filter(|value|!matches!(*value,""|"default"|"system")).map(applications::Target::parse).transpose()?}else{None};
                #[cfg(target_os="windows")]
                if let Some(target)=application_target {return applications::windows::open(target,worker_error.clone(),worker_stop.clone(),armed.clone()).map(|(stream,frames,label)|(CaptureStream::Application(stream),frames,cpal::SupportedStreamConfig::new(2,48_000,cpal::SupportedBufferSize::Unknown,cpal::SampleFormat::F32),label));}
                #[cfg(not(any(target_os="macos",target_os="windows")))]
                if application_target.is_some(){return Err("此系统暂不支持按应用选择声音，请明确选择系统所有应用或麦克风。".into());}
                let host = audio_host(worker_kind == "display")?;
                #[cfg(target_os="macos")]
                let mut application=None;
                #[allow(unused_mut)]
                let mut label_override:Option<String>=None;
                let devices = if worker_kind == "microphone" {
                    input_list(&host)?
                } else {
                    Vec::new()
                };
                let selected_input = if worker_kind=="microphone" {microphone_id(selected.as_deref(), &devices)?}else{None};
                let device = if worker_kind == "display" {
                        #[cfg(target_os="macos")]
                        {if let Some(target)=application_target {let (device,tap,label)=applications::macos::Tap::open(&host,target)?;application=Some(tap);label_override=Some(label);Some(device)}else{Some(system_device(&host)?)}}
                        #[cfg(not(target_os="macos"))]
                        {Some(system_device(&host)?)}
                } else if let Some(id) = selected_input {
                    let id = id.parse().map_err(|_| "音频设备标识无效")?;
                    host.device_by_id(&id)
                } else {
                    host.default_input_device()
                }
                .ok_or("所选音频设备不可用，请重新选择")?;
                    #[cfg(not(target_os = "linux"))]
                    let config = if worker_kind == "display" && label_override.is_none() {
                    device.default_output_config()
                } else {
                    device.default_input_config()
                }
                .map_err(|e| e.to_string())?;
                let (raw, frames) = raw_input_channel();
                    #[cfg(target_os = "linux")]
                    let config = device.default_input_config().map_err(|e| e.to_string())?;
                    let stream_config = config.config();
                    // PulseAudio converts the server's native S24/S32/U8 format.
                    #[cfg(target_os = "linux")]
                    let sample_format = if host.id() == cpal::HostId::PulseAudio {
                        cpal::SampleFormat::F32
                    } else { config.sample_format() };
                    #[cfg(not(target_os = "linux"))]
                    let sample_format = config.sample_format();
                    let stream = match sample_format {
                    cpal::SampleFormat::F32 => input_stream::<f32>(
                        &device,
                        &stream_config,
                        raw,
                        worker_error.clone(),
                        worker_stop.clone(),
                        rebuild.clone(),
                        armed.clone(),
                    ),
                    cpal::SampleFormat::I16 => input_stream::<i16>(
                        &device,
                        &stream_config,
                        raw,
                        worker_error.clone(),
                        worker_stop.clone(),
                        rebuild.clone(),
                        armed.clone(),
                    ),
                    cpal::SampleFormat::U16 => input_stream::<u16>(
                        &device,
                        &stream_config,
                        raw,
                        worker_error.clone(),
                        worker_stop.clone(),
                        rebuild.clone(),
                        armed.clone(),
                    ),
                    format => Err(format!("尚未支持设备格式 {format}")),
                }?;
                if worker_stop.load(Ordering::Acquire) {
                    return Err("采集启动已取消".into());
                }
                let stream=CaptureStream::Device{stream,#[cfg(target_os="macos")]application};
                stream.play()?;
                let label = device
                    .description()
                    .map_err(|e| e.to_string())?
                    .name()
                    .to_string();
                    Ok::<_,String>((stream,frames,config,label_override.unwrap_or(label)))
                })();
                let (mut stream,frames,config,label) = match opened {
                    Ok(value) => value,
                    Err(_) if announced.is_none() && !worker_stop.load(Ordering::Acquire) && restarts<3 => {
                        restarts+=1;
                        std::thread::sleep(Duration::from_millis(300));
                        continue;
                    }
                    Err(message) => return Err(message),
                };
                let mut pipeline = if let Some(mut previous) = retained.take() {
                    send_packets(&packets, previous.reconfigure(config.sample_rate(), config.channels() as usize)?)?;
                    previous
                } else {
                    let pipe=Pipeline::new(config.sample_rate(), config.channels() as usize)?;
                    if worker_kind=="microphone" { pipe.with_microphone_filter() } else { pipe }
                };
                if let Some(ready) = announced.take() { ready.send(Ok(label)).map_err(|_| "采集启动已取消")?; }
                while !worker_stop.load(Ordering::Acquire) && !rebuild.load(Ordering::Acquire) {
                    if let Err(message)=stream.check(){*worker_error.lock().unwrap()=Some(message);worker_stop.store(true,Ordering::Release);}
                    match frames.recv_timeout(Duration::from_millis(200)) {
                        Ok(data) => {pipeline.set_processing(processing.lock().unwrap().take());send_packets(&packets, pipeline.push(&data)?)?;},
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => break,
                    }
                }
                drop(stream);
                if rebuild.load(Ordering::Acquire) && !worker_stop.load(Ordering::Acquire) {
                    if stable_since.elapsed() >= Duration::from_secs(10) { restarts=0; }
                    prepare_restart(&packets,&mut pipeline,frames,restarts)?;
                    restarts += 1;
                    stable_since=std::time::Instant::now();
                    retained=Some(pipeline);
                    std::thread::sleep(Duration::from_millis(150));
                    continue;
                }
                finish_capture(&packets, pipeline, frames, worker_discard.load(Ordering::Acquire))?;
                return Ok::<(), String>(());
                }
            })();
            if let Err(message) = result {
                worker_stop.store(true, Ordering::Release);
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

    pub fn set_native_kind(&self, record_id: &str, kind: &str, enabled: bool) -> Result<(), String> {
        if !["display", "microphone"].contains(&kind) || record_id.len() != 36 { return Err("音源选择无效".into()); }
        let mut intents = self.intents.lock().unwrap(); intents.insert((record_id.into(), kind.into()), enabled);
        if !enabled {
            let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
            for session in sessions.into_iter().filter(|session| session.kind == kind) {
                let binding=session.binding.lock().unwrap().clone();
                if binding.as_ref().is_none_or(|value|value["recordId"] == record_id) {
                    session.user_disabled.store(true,Ordering::Release); session.stop.store(true,Ordering::Release);
                }
            }
        }
        Ok(())
    }
    pub fn abandon_prepared(&self, id: &str) {
        let session=self.sessions.lock().unwrap().get(id).cloned();
        if let Some(session)=session { if session.native_bound.load(Ordering::Acquire) { let _=self.stop_direct(id,"source"); } else { let _=self.stop(id,true); } }
    }
    pub fn refresh_native_pending(&self) {
        let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        for session in sessions { if session.native_bound.load(Ordering::Acquire) {
            match session.receiver.native_progress() {
                Ok((_, receipt, _, _)) => {
                    session.native_purged.store(receipt.purged, Ordering::Release);
                    if receipt.error.is_some() { session.stop.store(true, Ordering::Release); }
                    session.native_pending.store(!(receipt.finished || receipt.purged), Ordering::Release);
                }
                Err(_) => { session.native_pending.store(true, Ordering::Release); session.stop.store(true, Ordering::Release); }
            }
        } }
    }
    pub fn native_status(&self) -> Option<NativeStatus> {
        let descriptors = self.direct_sessions();
        let current = descriptors.iter().find(|value| value["stopped"] == false).or_else(|| descriptors.last())?;
        let record_id = current["recordId"].as_str()?.to_string();
        let mut status = NativeStatus { record_id: record_id.clone(), recording:false,microphone_on:false,paused:false,can_resume:false,duration_ms:0,rms:0.0,pending_count:0 };
        let mut sealed = false; let mut purged = false;
        let sessions = self.sessions.lock().unwrap().clone();
        for descriptor in descriptors.iter().filter(|value| value["recordId"] == record_id) {
            let session = sessions.get(descriptor["id"].as_str()?)?;
            let capturing = !session.stop.load(Ordering::Acquire);
            status.recording |= capturing;
            status.microphone_on |= capturing && session.kind == "microphone";
            sealed |= session.receiver.action() == "seal";
            let produced = session.receiver.progress().0;
            status.duration_ms = status.duration_ms.max(native_timeline_end(&descriptor["source"], produced));
            match session.receiver.native_progress() {
                Ok((manifest, receipt, rms, _)) => { purged |= receipt.purged; if !receipt.purged { status.pending_count += (manifest.last_sequence - receipt.watermark).max(0) as u64; } if capturing { status.rms = status.rms.max(rms as f64); } }
                Err(_) => status.pending_count += 1,
            }
        }
        status.paused = !status.recording && !sealed && !purged;
        status.can_resume = status.paused && status.pending_count == 0; Some(status)
    }
    pub fn stop_record(&self, record_id: &str, action: &str) -> Result<(), String> {
        let descriptors = self.direct_sessions(); let mut failure = None;
        for value in descriptors.iter().filter(|value| value["recordId"] == record_id) {
            if let Err(error) = self.stop_direct(value["id"].as_str().ok_or("音频连接无效")?, action) { failure.get_or_insert(error); }
        }
        match failure { Some(error) => Err(error), None => Ok(()) }
    }
    pub fn direct_sessions(&self) -> Vec<serde_json::Value> {
        let mut sessions: Vec<_> = self.sessions.lock().unwrap().iter().filter_map(|(id, session)| {
            let binding = session.binding.lock().unwrap().clone()?;
            Some((id.rsplit('-').next().unwrap_or("").parse::<u64>().unwrap_or(0), serde_json::json!({"id":id,"label":binding["source"]["label"],"source":binding["source"],"recordId":binding["recordId"],"stopped":session.stop.load(Ordering::Acquire),"action":session.receiver.action(),"purged":session.native_purged.load(Ordering::Acquire),"disconnected":session.user_disabled.load(Ordering::Acquire)})))
        }).collect();
        sessions.sort_by_key(|(serial, _)| *serial); sessions.into_iter().map(|(_, value)| value).collect()
    }
    pub fn direct_timeline(&self, record_id: &str) -> u64 {
        let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        sessions.into_iter().filter_map(|session| {
            let binding = session.binding.lock().unwrap().clone()?;
            if binding.get("recordId").and_then(|value| value.as_str()) != Some(record_id) { return None; }
            Some(native_timeline_end(&binding["source"], session.receiver.progress().0))
        }).max().unwrap_or(0)
    }
    pub fn bind_direct(&self, id: &str, root: &std::path::Path, binding: serde_json::Value) -> Result<(), String> {
        let session = self.sessions.lock().unwrap().get(id).cloned().ok_or("采集已结束")?;
        if session.armed.load(Ordering::Acquire) || session.stop.load(Ordering::Acquire) { return Err("音频连接已失效".into()); }
        let lease = binding.get("leaseId").and_then(|value| value.as_str()).ok_or("音频连接响应无效")?;
        if binding.get("protocol").and_then(|value| value.as_str()) != Some("native-file-v1") || binding.get("source").and_then(|value| value.get("id")).and_then(|value| value.as_str()).is_none() { return Err("音频连接响应无效".into()); }
        session.receiver.bind_native(native_spool::NativeSpool::bind(root, lease)?)?;
        let candidates = self.sessions.lock().unwrap().clone();
        let removable: Vec<_> = candidates.into_iter().filter_map(|(other_id, other)| {
            (other_id != id && other.stop.load(Ordering::Acquire) && other.native_bound.load(Ordering::Acquire) && other.receiver.native_progress().is_ok_and(|(_, receipt, _, _)| receipt.finished || receipt.purged)).then_some(other_id)
        }).collect();
        { let mut sessions=self.sessions.lock().unwrap(); for other_id in removable { sessions.remove(&other_id); } }
        *session.binding.lock().unwrap() = Some(binding);
        session.native_bound.store(true, Ordering::Release);
        session.native_pending.store(true, Ordering::Release);
        let intents=self.intents.lock().unwrap();
        let binding=session.binding.lock().unwrap(); let record_id=binding.as_ref().and_then(|value|value["recordId"].as_str()).unwrap_or("");
        if session.stop.load(Ordering::Acquire) || intents.get(&(record_id.into(),session.kind.clone())) == Some(&false) { return Err("此音源接入已取消".into()); }
        let offset=(binding.as_ref().and_then(|value|value["source"]["timelineOffsetMs"].as_f64()).unwrap_or(0.0)*16.0).round() as u64;
        *session.processing.lock().unwrap()=Some(dsp::Processor::new(record_id,session.kind=="microphone",offset)?);
        session.armed.store(true, Ordering::Release); Ok(())
    }
    pub fn direct_progress(&self, id: &str) -> Result<serde_json::Value, String> {
        let session = self.sessions.lock().unwrap().get(id).cloned().ok_or("采集已结束")?;
        let (manifest, receipt, rms, quiet) = session.receiver.native_progress()?;
        session.native_pending.store(!(receipt.finished || receipt.purged), Ordering::Release);
        let failure = session.error.lock().unwrap().clone();
        Ok(serde_json::json!({"sampleEnd": manifest.sample_end, "acknowledgedSampleEnd": receipt.sample_end, "bufferedBytes": if receipt.purged {0} else {(manifest.sample_end-receipt.sample_end)*2}, "rms":rms,"quietSeconds":quiet,"stopped":session.stop.load(Ordering::Acquire),"finished":receipt.finished,"error":receipt.error.or(failure)}))
    }
    pub fn stop_direct(&self, id: &str, action: &str) -> Result<serde_json::Value, String> {
        let session = self.sessions.lock().unwrap().get(id).cloned().ok_or("采集已结束")?;
        session.receiver.native_action(action)?;
        session.stop.store(true, Ordering::Release); session.receiver.wait_closed()?;
        let manifest = session.receiver.native_manifest()?;
        let binding = session.binding.lock().unwrap().clone().ok_or("音频连接无效")?;
        let source = binding.get("source").ok_or("音频连接无效")?;
        Ok(serde_json::json!({"sourceId":source["id"],"sessionId":source["sessionId"],"epoch":source["epoch"],"lastSequence":manifest.last_sequence,"sampleEnd":manifest.sample_end}))
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
        if session.native_bound.load(Ordering::Acquire) { return Err("本机直传音频无需页面读取".into()); }
        let result = session.receiver.pending();
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

    pub fn progress(&self, id: &str) -> Result<Progress, String> {
        let session = self.sessions.lock().unwrap().get(id).cloned().ok_or("采集已结束")?;
        if session.native_bound.load(Ordering::Acquire) { return Err("请通过本机直传进度接口读取状态".into()); }
        let (sample_end, acknowledged_sample_end, buffered_bytes) = session.receiver.progress();
        Ok(Progress { sample_end, acknowledged_sample_end, buffered_bytes })
    }

    pub fn acknowledge(&self, id: &str, sequence: u32, sample_offset: u32, sample_count: u32) -> Result<(), String> {
        let session = self.sessions.lock().unwrap().get(id).cloned().ok_or("采集已结束")?;
        if session.native_bound.load(Ordering::Acquire) { return Err("本机直传音频由后台确认".into()); }
        session.receiver.acknowledge(sequence, sample_offset, sample_count)
    }

    pub fn stop(&self, id: &str, discard: bool) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get(id) {
            if session.native_bound.load(Ordering::Acquire) { return Err("本机直传录音需要保存尾部后停止".into()); }
            session.discard.store(discard, Ordering::Release);
            session.stop.store(true, Ordering::Release);
            if discard { session.receiver.cancel(); }
        }
        if discard {
            sessions.remove(id);
        }
        Ok(())
    }

    pub fn stop_all(&self) { let _ = self.stop_all_safe(); }
    pub fn stop_all_safe(&self) -> Result<(), String> {
        let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        for session in &sessions {
            if session.receiver.direct() { let _ = session.receiver.native_action("pause"); }
            else { session.discard.store(true, Ordering::Release); session.receiver.cancel(); }
            session.stop.store(true, Ordering::Release);
        }
        let mut failure = None;
        for session in sessions { if session.receiver.direct() { if let Err(error) = session.receiver.wait_closed() { failure.get_or_insert(error); } } }
        match failure { Some(error) => Err(error), None => Ok(()) }
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

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires the disposable CI PulseAudio null sink"]
    fn linux_monitor_captures_output_without_microphone() {
        assert_eq!(std::env::var("TTS_LINUX_AUDIO_TEST").as_deref(), Ok("1"));
        let host = audio_host(true).unwrap();
        assert_eq!(host.default_output_device().unwrap().id().unwrap().id(), "lingji_ci");
        let captures = Captures::default();
        let started = captures.start("display", None).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(12);
        let mut samples = 0u32;
        let mut nonzero = false;
        while std::time::Instant::now() < deadline && samples < 16_000 {
            let packet = captures.read(&started.id).unwrap();
            if packet.is_empty() {
                std::thread::sleep(Duration::from_millis(20));
                continue;
            }
            let field = |at| u32::from_le_bytes(packet[at..at + 4].try_into().unwrap());
            assert_eq!(field(4), samples);
            assert_eq!(packet.len(), 12 + field(8) as usize * 2);
            nonzero |= packet[12..].chunks_exact(2).any(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs() > 100);
            captures.acknowledge(&started.id, field(0), field(4), field(8)).unwrap();
            samples += field(8);
        }
        captures.stop(&started.id, true).unwrap();
        assert!(samples >= 16_000, "system monitor did not deliver one second of PCM");
        assert!(nonzero, "system monitor did not capture the CI output tone");
    }
    #[test]
    fn exhausted_restart_budget_still_persists_all_tail_samples() {
        let packets=PacketQueue::new().unwrap();let mut pipeline=Pipeline::new(48_000,2).unwrap();
        send_packets(&packets,pipeline.push(&vec![0.25;4_800*2]).unwrap()).unwrap();
        let (sender,frames)=raw_input_channel();sender.send(vec![0.5;4_800*2]).unwrap();drop(sender);
        assert!(prepare_restart(&packets,&mut pipeline,frames,3).is_err());
        packets.close();let mut sequence=0;let mut offset=0;
        while let Some(packet)=packets.pending().unwrap(){
            let read=|at|u32::from_le_bytes(packet[at..at+4].try_into().unwrap());
            assert_eq!(read(0),sequence);assert_eq!(read(4),offset);
            packets.acknowledge(read(0),read(4),read(8)).unwrap();sequence+=1;offset+=read(8);
        }
        assert_eq!(offset,3_200);
    }
    #[test]
    fn sample_rate_invalidation_requests_rebuild_instead_of_stopping_meeting() {
        let stop=AtomicBool::new(false);let warned=AtomicBool::new(false);let error=Mutex::new(None);
        let rebuild=AtomicBool::new(false);
        handle_stream_error(cpal::ErrorKind::StreamInvalidated.into(),&error,&stop,&warned,&rebuild);
        assert!(rebuild.load(Ordering::Acquire));
        assert!(!stop.load(Ordering::Acquire));assert!(error.lock().unwrap().is_none());
    }
    #[test]
    fn recoverable_stream_warning_keeps_the_same_available_audio() {
        for kind in [cpal::ErrorKind::Xrun, cpal::ErrorKind::DeviceChanged, cpal::ErrorKind::RealtimeDenied] {
            let (sender, receiver) = raw_input_channel();
            let stop = AtomicBool::new(false);
            let warned = AtomicBool::new(false);
            let error = Mutex::new(None);
            // WASAPI reports a discontinuity before delivering the available buffer.
            handle_stream_error(kind.into(), &error, &stop, &warned, &AtomicBool::new(false));
            queue_input(&sender, &[0.25f32, -0.25], &error, &stop);
            assert!(!stop.load(Ordering::Acquire), "recoverable {kind:?} must not disconnect system audio");
            assert!(error.lock().unwrap().is_none());
            assert_eq!(receiver.try_recv().unwrap(), vec![0.25, -0.25]);
            assert!(warned.load(Ordering::Relaxed));
        }
    }

    #[test]
    fn fatal_stream_errors_still_stop_and_do_not_accept_more_audio() {
        for kind in [cpal::ErrorKind::PermissionDenied, cpal::ErrorKind::BackendError] {
            let (sender, receiver) = raw_input_channel();
            let stop = AtomicBool::new(false);
            let warned = AtomicBool::new(false);
            let error = Mutex::new(None);
            handle_stream_error(kind.into(), &error, &stop, &warned, &AtomicBool::new(false));
            queue_input(&sender, &[0.25f32], &error, &stop);
            assert!(stop.load(Ordering::Acquire));
            assert!(error.lock().unwrap().as_ref().unwrap().starts_with("音频设备停止："));
            assert!(receiver.try_recv().is_err());
            handle_stream_error(cpal::ErrorKind::Xrun.into(), &error, &stop, &warned, &AtomicBool::new(false));
            assert!(stop.load(Ordering::Acquire), "a warning must not restart a failed device");
            assert!(error.lock().unwrap().is_some());
        }
    }

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
    fn capture_errors_preserve_preaccepted_raw_frames_and_resampler_tail() {
        for overflow in [true, false] {
            let packets = PacketQueue::new().unwrap();
            let mut pipeline = Pipeline::new(48_000, 2).unwrap();
            send_packets(&packets, pipeline.push(&vec![0.25; 4_800 * 2]).unwrap()).unwrap();
            let (sender, frames) = raw_input_channel();
            let stop = AtomicBool::new(false);
            let error = Mutex::new(None);
            for _ in 0..256 { queue_input(&sender, &[0.25f32; 960], &error, &stop); }
            if overflow { queue_input(&sender, &[0.25f32; 960], &error, &stop); }
            else { handle_stream_error(cpal::ErrorKind::PermissionDenied.into(), &error, &stop, &AtomicBool::new(false), &AtomicBool::new(false)); }
            assert!(stop.load(Ordering::Acquire));
            finish_capture(&packets, pipeline, frames, false).unwrap();
            packets.close();
            let mut samples = 0;
            while let Some(packet) = packets.pending().unwrap() {
                let read = |at| u32::from_le_bytes(packet[at..at + 4].try_into().unwrap());
                samples += read(8); packets.acknowledge(read(0), read(4), read(8)).unwrap();
            }
            assert_eq!(samples, 42_560);
            assert!(error.lock().unwrap().is_some(), "the capture failure must still be reported");
        }
    }

    #[test]
    fn explicit_discard_skips_tail_and_encoding_failures_still_fail() {
        let packets = PacketQueue::new().unwrap();
        let (sender, frames) = raw_input_channel(); sender.send(vec![0.25; 960]).unwrap();
        finish_capture(&packets, Pipeline::new(48_000, 2).unwrap(), frames, true).unwrap();
        packets.close(); assert!(packets.pending().unwrap().is_none());
        let (sender, frames) = raw_input_channel(); sender.send(vec![0.25]).unwrap();
        assert!(finish_capture(&PacketQueue::new().unwrap(), Pipeline::new(48_000, 2).unwrap(), frames, false).is_err());
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
        let expected: Vec<Vec<u8>> = (0..180u32).map(|i| [i.to_le_bytes().as_slice(), (i*16000).to_le_bytes().as_slice(), 16000u32.to_le_bytes().as_slice(), &vec![42;32000]].concat()).collect();
        send_packets(&packets, expected.clone()).unwrap();
        packets.close();
        for packet in expected {
            assert_eq!(packets.pending().unwrap(), Some(packet.clone()));
            packets.acknowledge(u32::from_le_bytes(packet[..4].try_into().unwrap()), u32::from_le_bytes(packet[4..8].try_into().unwrap()), 16000).unwrap();
        }
        assert!(packets.pending().unwrap().is_none());
    }
    #[cfg(feature = "smoke-test")]
    #[test]
    fn native_capture_survives_delayed_frontend_reads_and_drains_on_stop() {
        let captures = Captures::default();
        let (ready, produced) = mpsc::sync_channel(0);
        let started = captures.synthetic_source("display", Some((560, ready))).unwrap();
        let session = captures.sessions.lock().unwrap()[&started.id].clone();
        produced.recv_timeout(Duration::from_secs(120)).expect("finite source must reach its stop barrier");
        assert!(captures.active());
        assert!(session.error.lock().unwrap().is_none());
        assert!(session.receiver.buffered_bytes() > 10 * (32_000 + 12), "finite producer must accumulate beyond the old queue before any read");
        captures.stop(&started.id, false).unwrap();
        assert!(captures.active(), "unacknowledged native audio must still block installation");
        let (mut sequence, mut offset) = (0u32, 0u32);
        loop {
            let packet = captures.read(&started.id).unwrap();
            if packet.is_empty() { break; }
            let field = |at| u32::from_le_bytes(packet[at..at + 4].try_into().unwrap());
            assert_eq!(field(0), sequence);
            assert_eq!(field(4), offset);
            assert_eq!(packet.len(), 12 + field(8) as usize * 2);
            captures.acknowledge(&started.id, sequence, offset, field(8)).unwrap();
            sequence += 1;
            offset += field(8);
        }
        assert!(offset >= 9 * pipeline::RATE, "must preserve audio beyond the old eight-packet limit");
        assert_eq!(offset, 560 * (960 * pipeline::RATE / 48_000), "every finite source sample and the final tail must drain");
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
    #[cfg(feature = "smoke-test")]
    #[test]
    fn stopped_direct_kind_reopens_without_losing_pending_tail_or_timeline() {
        let root=tempfile::tempdir().unwrap();let captures=Captures::default();
        let first=captures.prepare_synthetic("display").unwrap();let lease="c".repeat(64);std::fs::create_dir(root.path().join(&lease)).unwrap();
        let binding=serde_json::json!({"protocol":"native-file-v1","leaseId":lease,"recordId":"record","source":{"id":"first","sessionId":"session","epoch":"epoch","label":"synthetic","timelineOffsetMs":2004.9375}});
        captures.bind_direct(&first.id,root.path(),binding).unwrap();
        assert!(captures.read(&first.id).is_err());assert!(captures.stop(&first.id,true).is_err());assert!(captures.native_status().unwrap().recording);
        std::thread::sleep(Duration::from_millis(80));
        let manifest=captures.stop_direct(&first.id,"pause").unwrap();let samples=manifest["sampleEnd"].as_u64().unwrap();assert!(samples>0);
        assert_eq!(captures.direct_timeline("record"),(2004.9375 + samples as f64 / 16.0).ceil() as u64);
        let second=captures.prepare_synthetic("display").unwrap();let lease2="d".repeat(64);std::fs::create_dir(root.path().join(&lease2)).unwrap();
        let binding=serde_json::json!({"protocol":"native-file-v1","leaseId":lease2,"recordId":"record","source":{"id":"second","sessionId":"session2","epoch":"epoch2","label":"synthetic","timelineOffsetMs":captures.direct_timeline("record")}});
        captures.bind_direct(&second.id,root.path(),binding).unwrap();
        assert_eq!(captures.direct_sessions().len(),2,"unacknowledged source must remain visible to the native barrier");
        captures.stop_direct(&second.id,"pause").unwrap();assert!(captures.active());
    }

    #[cfg(feature = "smoke-test")]
    #[test]
    fn only_confirmed_raw_purge_releases_native_pending_after_record_deletion() {
        let root=tempfile::tempdir().unwrap();let captures=Captures::default();let started=captures.prepare_synthetic("display").unwrap();let lease="e".repeat(64);let directory=root.path().join(&lease);std::fs::create_dir(&directory).unwrap();
        captures.bind_direct(&started.id,root.path(),serde_json::json!({"protocol":"native-file-v1","leaseId":lease,"recordId":"record","source":{"id":"source","label":"synthetic","sessionId":"session","epoch":"epoch","timelineOffsetMs":0}})).unwrap();
        std::thread::sleep(Duration::from_millis(75));captures.stop_direct(&started.id,"pause").unwrap();
        let path=directory.join("receipt.json");
        for error in ["native_packet_corrupt","record_expired"] {
            std::fs::write(&path,serde_json::json!({"schema":1,"leaseId":lease,"watermark":-1,"sampleEnd":0,"finished":false,"error":error}).to_string()).unwrap();
            captures.refresh_native_pending();assert!(captures.active(),"an error alone is not a durable ACK or completed purge");
        }
        for file in std::fs::read_dir(&directory).unwrap() { let path=file.unwrap().path();if path.extension().is_some_and(|value|value=="pcm") {std::fs::remove_file(path).unwrap();} }
        std::fs::write(&path,serde_json::json!({"schema":1,"leaseId":lease,"watermark":-1,"sampleEnd":0,"finished":false,"error":"record_expired","purged":true}).to_string()).unwrap();
        captures.refresh_native_pending();assert!(!captures.active());let status=captures.native_status().unwrap();assert!(!status.paused);assert!(!status.can_resume);assert_eq!(status.pending_count,0);
    }

    #[cfg(feature = "smoke-test")]
    #[test]
    fn microphone_disabled_during_prepare_never_arms_or_writes_pcm() {
        let root=tempfile::tempdir().unwrap();let captures=Captures::default();let record_id="00000000-0000-4000-8000-000000000001";
        captures.set_native_kind(record_id,"microphone",true).unwrap();let started=captures.prepare_synthetic("microphone").unwrap();
        captures.set_native_kind(record_id,"microphone",false).unwrap();let lease="f".repeat(64);let directory=root.path().join(&lease);std::fs::create_dir(&directory).unwrap();
        assert!(captures.bind_direct(&started.id,root.path(),serde_json::json!({"protocol":"native-file-v1","leaseId":lease,"recordId":record_id,"source":{"id":"source","kind":"microphone","label":"synthetic","sessionId":"session","epoch":"epoch","timelineOffsetMs":0}})).is_err());
        captures.abandon_prepared(&started.id);assert!(!captures.active());assert!(!std::fs::read_dir(directory).unwrap().any(|file|file.unwrap().path().extension().is_some_and(|value|value=="pcm")));
    }

}
