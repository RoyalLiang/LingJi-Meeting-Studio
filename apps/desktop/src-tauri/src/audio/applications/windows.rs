use super::{Application,Applications,Target};
use std::{collections::BTreeMap,mem::{size_of,ManuallyDrop},sync::{mpsc::{self,Receiver,SyncSender},Arc,Mutex,atomic::{AtomicBool,Ordering}},thread::JoinHandle,time::{Duration,Instant}};
use windows::{core::{implement,Interface,Ref,HRESULT,BOOL},Win32::{Foundation::{CloseHandle,FILETIME,HANDLE,HWND,LPARAM},Media::Audio::*,System::{Com::{CoInitializeEx,CoUninitialize,COINIT_MULTITHREADED,BLOB,StructuredStorage::{PROPVARIANT,PROPVARIANT_0,PROPVARIANT_0_0,PROPVARIANT_0_0_0}},Threading::{OpenProcess,GetProcessTimes,GetExitCodeProcess,QueryFullProcessImageNameW,PROCESS_QUERY_LIMITED_INFORMATION,PROCESS_NAME_WIN32},Variant::VT_BLOB,SystemInformation::OSVERSIONINFOW},UI::WindowsAndMessaging::{EnumWindows,IsWindowVisible,GetWindowThreadProcessId}}};
#[link(name="ntdll")]
unsafe extern "system" {fn RtlGetVersion(info:*mut OSVERSIONINFOW)->i32;}
fn supported()->Result<bool,String>{let mut version=OSVERSIONINFOW{dwOSVersionInfoSize:size_of::<OSVERSIONINFOW>() as u32,..Default::default()};if unsafe{RtlGetVersion(&mut version)}<0{return Err("无法确认 Windows 版本，请重试。".into());}Ok(version.dwBuildNumber>=20348)}
struct Process(HANDLE);
impl Drop for Process{fn drop(&mut self){let _=unsafe{CloseHandle(self.0)};}}
impl Process {
 fn open(pid:u32)->Result<Self,String>{unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid)}.map(Self).map_err(|_|"所选应用已退出或无法访问，请重新选择应用。".into())}
 fn target(&self,pid:u32)->Result<Target,String>{let (mut created,mut exited,mut kernel,mut user)=(FILETIME::default(),FILETIME::default(),FILETIME::default(),FILETIME::default());unsafe{GetProcessTimes(self.0,&mut created,&mut exited,&mut kernel,&mut user)}.map_err(|_|"无法确认所选应用，请重新选择。")?;Ok(Target{pid,started:(((created.dwHighDateTime as u64)<<32)|created.dwLowDateTime as u64).to_string()})}
 fn active(&self)->bool{let mut code=0;unsafe{GetExitCodeProcess(self.0,&mut code)}.is_ok()&&code==259}
 fn label(&self)->Option<String>{let mut buffer=vec![0u16;32768];let mut count=buffer.len() as u32;unsafe{QueryFullProcessImageNameW(self.0,PROCESS_NAME_WIN32,windows::core::PWSTR(buffer.as_mut_ptr()),&mut count)}.ok()?;let path=String::from_utf16_lossy(&buffer[..count as usize]);std::path::Path::new(&path).file_stem().map(|value|value.to_string_lossy().into_owned())}
}
unsafe extern "system" fn visible_window(window:HWND,data:LPARAM)->BOOL{
 if unsafe{IsWindowVisible(window)}.as_bool(){let mut pid=0;unsafe{GetWindowThreadProcessId(window,Some(&mut pid))};if pid!=0&&pid!=std::process::id(){let values=unsafe{&mut *(data.0 as *mut BTreeMap<u32,Application>)};if values.len()<256&&!values.contains_key(&pid){if let Ok(process)=Process::open(pid){if let (Ok(target),Some(label))=(process.target(pid),process.label()){if selectable(&label){values.insert(pid,Application{id:target.id(),label});}}}}}}BOOL(1)
}
fn selectable(label:&str)->bool{!matches!(label.to_ascii_lowercase().as_str(),"explorer"|"applicationframehost"|"runtimebroker"|"shellexperiencehost"|"startmenuexperiencehost"|"searchhost"|"dwm")}
pub fn list()->Result<Applications,String>{
 if !supported()?{return Ok(Applications{supported:false,applications:Vec::new(),reason:Some("按应用录音需要 Windows build 20348 或更高版本。".into())});}
 let mut values=BTreeMap::<u32,Application>::new();unsafe{EnumWindows(Some(visible_window),LPARAM((&mut values as *mut BTreeMap<u32,Application>) as isize))}.map_err(|_|"无法读取可选应用，请刷新后重试。")?;
 let mut applications:Vec<_>=values.into_values().collect();super::distinguish_instances(&mut applications);applications.sort_by(|a,b|a.label.cmp(&b.label));Ok(Applications{supported:true,applications,reason:None})
}
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Completion {ready:SyncSender<()>,_activation:Box<AUDIOCLIENT_ACTIVATION_PARAMS>}
impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
 fn ActivateCompleted(&self,_operation:Ref<IActivateAudioInterfaceAsyncOperation>)->windows::core::Result<()>{let _=self.ready.try_send(());Ok(())}
}
struct Com;
impl Com {fn open()->Result<Self,String>{unsafe{CoInitializeEx(None,COINIT_MULTITHREADED)}.ok().map_err(|_|"无法初始化应用音频，请重试。")?;Ok(Self)}}
impl Drop for Com{fn drop(&mut self){unsafe{CoUninitialize()};}}
struct Client(IAudioClient);
impl Drop for Client{fn drop(&mut self){let _=unsafe{self.0.Stop()};}}
fn activation(selected:&Target)->Result<IAudioClient,String>{
 let (sender,ready)=mpsc::sync_channel(1);
 let mut activation=Box::new(AUDIOCLIENT_ACTIVATION_PARAMS{ActivationType:AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,Anonymous:AUDIOCLIENT_ACTIVATION_PARAMS_0{ProcessLoopbackParams:AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS{TargetProcessId:selected.pid,ProcessLoopbackMode:PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE}}});
 // The callback owns the borrowed blob until asynchronous activation finishes, including after a timeout.
 let pointer=(&mut *activation as *mut AUDIOCLIENT_ACTIVATION_PARAMS).cast();
 let completion:IActivateAudioInterfaceCompletionHandler=Completion{ready:sender,_activation:activation}.into();
 let parameters=PROPVARIANT{Anonymous:PROPVARIANT_0{Anonymous:ManuallyDrop::new(PROPVARIANT_0_0{vt:VT_BLOB,Anonymous:PROPVARIANT_0_0_0{blob:BLOB{cbSize:size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,pBlobData:pointer}},..Default::default()})}};
 let operation=unsafe{ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,&IAudioClient::IID,Some(&parameters),&completion)}.map_err(|_|"无法接入所选应用声音，请确认 Windows 支持按应用录音。")?;
 ready.recv_timeout(Duration::from_secs(5)).map_err(|_|"接入应用声音超时，请重新选择应用。")?;
 let mut result=HRESULT(0);let mut interface=None;unsafe{operation.GetActivateResult(&mut result,&mut interface)}.map_err(|_|"应用音频初始化失败，请重试。")?;result.ok().map_err(|_|"无法接入所选应用声音，请检查应用是否仍在运行。")?;
 interface.ok_or("所选应用音频不可用，请重新选择应用。")?.cast().map_err(|_|"所选应用音频不可用，请重新选择应用。".into())
}
fn run(selected:Target,sender:SyncSender<Vec<f32>>,error:Arc<Mutex<Option<String>>>,stop:Arc<AtomicBool>,armed:Arc<AtomicBool>,ready:SyncSender<Result<String,String>>)->Result<(),String>{
 let _com=Com::open()?;let process=Process::open(selected.pid)?;
 if process.target(selected.pid)?!=selected||!process.active(){return Err("所选应用已退出或重新启动，请重新选择应用。".into());}
 let label=process.label().ok_or("无法确认所选应用，请重新选择。")?;if !selectable(&label){return Err("此进程承载多个应用，请选择具体会议应用或明确选择系统所有应用。".into());}let client=Client(activation(&selected)?);
 let format=WAVEFORMATEX{wFormatTag:WAVE_FORMAT_PCM as u16,nChannels:2,nSamplesPerSec:48_000,nAvgBytesPerSec:192_000,nBlockAlign:4,wBitsPerSample:16,cbSize:0};
 unsafe{client.0.Initialize(AUDCLNT_SHAREMODE_SHARED,AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM|AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,1_000_000,0,&format,None)}.map_err(|_|"无法打开所选应用音源，请播放应用声音后重试。")?;
 let capture:IAudioCaptureClient=unsafe{client.0.GetService()}.map_err(|_|"无法读取应用声音，请重试。")?;
 if !process.active(){return Err("所选应用已退出，请重新选择应用。".into());}
 unsafe{client.0.Start()}.map_err(|_|"无法启动所选应用声音，请重试。")?;
 ready.send(Ok(format!("应用声音 · {label}"))).map_err(|_|"应用音频接入已取消。")?;
 let mut checked=Instant::now();let mut last_packet=Instant::now();let mut received=false;
 while !stop.load(Ordering::Acquire){
  if checked.elapsed()>=Duration::from_millis(500){if !process.active(){return Err("所选应用已退出，请重新接入声音来源。".into());}checked=Instant::now();}
  let frames=unsafe{capture.GetNextPacketSize()}.map_err(|_|"应用声音读取中断，请重新接入此音源。")?;
  if !armed.load(Ordering::Acquire){last_packet=Instant::now();}
  if frames==0 {if last_packet.elapsed()>Duration::from_secs(3){return Err("所选应用未提供音频数据，请播放会议声音后重新接入。".into());}std::thread::sleep(Duration::from_millis(5));continue;}
  let mut data=std::ptr::null_mut();let mut count=0;let mut flags=0;
  unsafe{capture.GetBuffer(&mut data,&mut count,&mut flags,None,None)}.map_err(|_|"应用声音读取中断，请重新接入此音源。")?;
  if !process.active(){let _=unsafe{capture.ReleaseBuffer(count)};return Err("所选应用已退出，请重新接入声音来源。".into());}
  if count==0 {let _=unsafe{capture.ReleaseBuffer(0)};std::thread::sleep(Duration::from_millis(5));continue;}
  last_packet=Instant::now();
  if count>96_000 {let _=unsafe{capture.ReleaseBuffer(count)};return Err("应用声音缓冲异常，请重新接入此音源。".into());}
  if flags&AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32!=0&&received {let _=unsafe{capture.ReleaseBuffer(count)};return Err("所选应用声音发生中断，请重新接入此音源。".into());}
  let silent=flags&AUDCLNT_BUFFERFLAGS_SILENT.0 as u32!=0;
  if data.is_null()&&!silent&&count>0 {let _=unsafe{capture.ReleaseBuffer(count)};return Err("应用声音数据不可用，请重新接入此音源。".into());}
  if armed.load(Ordering::Acquire)&&count>0{
   let input=if silent{vec![0.0;count as usize*2]}else{unsafe{std::slice::from_raw_parts(data.cast::<i16>(),count as usize*2)}.iter().map(|sample|*sample as f32/32768.0).collect()};
   super::super::queue_input(&sender,&input,&error,&stop);received=true;
  }
  unsafe{capture.ReleaseBuffer(count)}.map_err(|_|"应用声音缓冲已失效，请重新接入此音源。")?;
 }
 Ok(())
}
pub struct Capture {stop:Arc<AtomicBool>,worker:Option<JoinHandle<()>>}
impl Capture {pub fn check(&self)->Result<(),String>{Ok(())}}
impl Drop for Capture {fn drop(&mut self){self.stop.store(true,Ordering::Release);if let Some(worker)=self.worker.take(){let _=worker.join();}}}
pub fn open(selected:Target,error:Arc<Mutex<Option<String>>>,stop:Arc<AtomicBool>,armed:Arc<AtomicBool>)->Result<(Capture,Receiver<Vec<f32>>,String),String>{
 if !supported()?{return Err("按应用录音需要 Windows build 20348 或更高版本；此选择不会改采系统声音。".into());}
 let (sender,frames)=super::super::raw_input_channel();let (ready,waiting)=mpsc::sync_channel(1);let worker_stop=stop.clone();
 let worker=std::thread::spawn(move||{let result=run(selected,sender,error.clone(),worker_stop.clone(),armed,ready.clone());if let Err(message)=result{let _=ready.try_send(Err(message.clone()));*error.lock().unwrap()=Some(message);worker_stop.store(true,Ordering::Release);}});
 let guard=Capture{stop,worker:Some(worker)};
 let label=waiting.recv_timeout(Duration::from_secs(7)).map_err(|_|"接入应用声音超时，请重试。")??;
 Ok((guard,frames,label))
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn shared_desktop_hosts_are_not_presented_as_a_single_application(){
  for name in ["explorer","ApplicationFrameHost","RuntimeBroker","dwm"]{assert!(!selectable(name));}
  assert!(selectable("ms-teams"));assert!(selectable("chrome"));
 }
 #[test]
 fn a_stale_creation_time_is_rejected_before_audio_activation(){
  let pid=std::process::id();let process=Process::open(pid).unwrap();let current=process.target(pid).unwrap();assert!(process.active());assert_eq!(process.target(pid).unwrap(),current);
  let stale=Target{pid,started:format!("{}0",current.started)};let (sender,_)=super::super::super::raw_input_channel();let (ready,_)=mpsc::sync_channel(1);
  let result=run(stale,sender,Arc::new(Mutex::new(None)),Arc::new(AtomicBool::new(false)),Arc::new(AtomicBool::new(false)),ready);
  assert!(result.unwrap_err().contains("重新选择"));
 }
}
