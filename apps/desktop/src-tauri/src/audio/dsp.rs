use std::{collections::{HashMap, VecDeque}, ffi::{c_int, c_void}, ptr::NonNull, sync::{Arc, Mutex, OnceLock, Weak}};

const FRAME: usize = 160;
const RATE: c_int = 16_000;
unsafe extern "C" {
 fn speex_echo_state_init(frame: c_int, filter: c_int) -> *mut c_void;
 fn speex_echo_state_destroy(state: *mut c_void);
 fn speex_echo_ctl(state: *mut c_void, request: c_int, value: *mut c_void) -> c_int;
 fn speex_echo_cancellation(state: *mut c_void, near: *const i16, far: *const i16, out: *mut i16);
 fn speex_preprocess_state_init(frame: c_int, rate: c_int) -> *mut c_void;
 fn speex_preprocess_state_destroy(state: *mut c_void);
 fn speex_preprocess_ctl(state: *mut c_void, request: c_int, value: *mut c_void) -> c_int;
 fn speex_preprocess_run(state: *mut c_void, frame: *mut i16) -> c_int;
}
#[derive(Default)]
struct Reference { start: u64, samples: VecDeque<i16> }
impl Reference {
 fn push(&mut self, offset: u64, samples: &[i16]) {
  if self.start + self.samples.len() as u64 != offset {self.samples.clear();self.start=offset;}
  self.samples.extend(samples);
  let excess=self.samples.len().saturating_sub(RATE as usize * 2);
  self.samples.drain(..excess);self.start+=excess as u64;
 }
 fn frame(&self, offset: u64) -> [i16; FRAME] {
  let mut out=[0;FRAME];
  for (i,value) in out.iter_mut().enumerate() {if let Some(at)=(offset+i as u64).checked_sub(self.start) {if let Some(sample)=self.samples.get(at as usize) {*value=*sample;}}}
  out
 }
}
type SharedReference=Arc<Mutex<Reference>>;
fn reference(record: &str) -> SharedReference {
 static REFERENCES: OnceLock<Mutex<HashMap<String,Weak<Mutex<Reference>>>>>=OnceLock::new();
 let mut refs=REFERENCES.get_or_init(Default::default).lock().unwrap();
 refs.retain(|_,reference|reference.strong_count()>0);
 if let Some(value)=refs.get(record).and_then(Weak::upgrade) {return value;}
 let value=Arc::new(Mutex::new(Reference::default()));refs.insert(record.into(),Arc::downgrade(&value));value
}

pub struct Processor {
 record: String, received: u64, produced: u64, latency: usize,
 reference: SharedReference, microphone: bool, offset: u64, pending: VecDeque<i16>,
 echo: Option<NonNull<c_void>>, noise: Option<NonNull<c_void>>,
}
// C states have one owner and are used only by that capture's processing thread.
unsafe impl Send for Processor {}
impl Processor {
 pub fn new(record: &str, microphone: bool, offset: u64) -> Result<Self,String> {
  let mut result=Self{record:record.into(),received:0,produced:0,latency:FRAME,reference:reference(record),microphone,offset,pending:VecDeque::new(),echo:None,noise:None};
  if microphone {unsafe {
   result.echo=NonNull::new(speex_echo_state_init(FRAME as c_int, RATE/4));
   result.noise=NonNull::new(speex_preprocess_state_init(FRAME as c_int,RATE));
   let (Some(echo),Some(noise))=(result.echo,result.noise) else{return Err("无法初始化麦克风音频处理".into());};
   let mut rate=RATE;
   if speex_echo_ctl(echo.as_ptr(),24,(&mut rate as *mut c_int).cast())!=0 {return Err("无法配置回声处理采样率".into());}
   // Keep natural speech levels: noise suppression on, automatic gain and VAD off.
   for (request,mut value) in [(0,1),(2,0),(18,-15)] {
    if speex_preprocess_ctl(noise.as_ptr(),request,(&mut value as *mut c_int).cast())!=0 {return Err("无法配置麦克风降噪".into());}
   }
   if speex_preprocess_ctl(noise.as_ptr(),24,echo.as_ptr())!=0 {return Err("无法连接残余回声处理".into());}
  }}
  Ok(result)
 }
 pub fn push(&mut self, samples: &[i16], finish: bool) -> Result<Vec<i16>,String> {
  if !self.microphone {
   self.reference.lock().unwrap().push(self.offset,samples);self.offset+=samples.len() as u64;return Ok(samples.to_vec());
  }
  self.received+=samples.len() as u64;
  self.pending.extend(samples);
  let mut output=Vec::with_capacity(samples.len()+FRAME);
  // Three frames of lookahead let the already-selected playback callback supply its reference.
  while self.pending.len()>=FRAME*4 || (finish && self.produced<self.received) {
   let count=self.pending.len().min(FRAME);let mut near=[0;FRAME];
   for value in &mut near[..count] {*value=self.pending.pop_front().unwrap();}
   let far=if count==0 {[0;FRAME]}else{self.reference.lock().unwrap().frame(self.offset)};let mut processed=[0;FRAME];
   unsafe {
    speex_echo_cancellation(self.echo.unwrap().as_ptr(),near.as_ptr(),far.as_ptr(),processed.as_mut_ptr());
    speex_preprocess_run(self.noise.unwrap().as_ptr(),processed.as_mut_ptr());
   }
   let skip=self.latency.min(FRAME);self.latency-=skip;
   let take=(FRAME-skip).min((self.received-self.produced) as usize);
   output.extend_from_slice(&processed[skip..skip+take]);self.produced+=take as u64;self.offset+=count as u64;
  }
  if finish {
   // Draining adds padded frames to the C state; reset at the format boundary before accepting more real PCM.
   *self=Self::new(&self.record,true,self.offset)?;
  }
  Ok(output)
 }
}
impl Drop for Processor {
 fn drop(&mut self) {unsafe {
  if let Some(state)=self.noise {speex_preprocess_state_destroy(state.as_ptr());}
  if let Some(state)=self.echo {speex_echo_state_destroy(state.as_ptr());}
 }}
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn exact_tails_reference_isolation_and_bounded_cache() {
  let mut far=Processor::new("dsp-exact",false,0).unwrap();let mut near=Processor::new("dsp-exact",true,0).unwrap();
  let samples:Vec<i16>=(0..32_037).map(|i|((i as f64*0.17).sin()*3000.0) as i16).collect();
  let mut output=Vec::new();
  for chunk in samples.chunks(347) {assert_eq!(far.push(chunk,false).unwrap(),chunk);output.extend(near.push(chunk,false).unwrap());}
  output.extend(near.push(&[],true).unwrap());assert_eq!(output.len(),samples.len());
  assert!(far.reference.lock().unwrap().samples.len()<=32_000);
  let other=Processor::new("dsp-other",true,0).unwrap();assert!(!Arc::ptr_eq(&far.reference,&other.reference));
 }
 #[test]
 fn short_tail_contains_the_sound_instead_of_only_overlap_delay() {
  let mut processor=Processor::new("dsp-short-tail",true,0).unwrap();
  for length in [37,160,197,640] {
   let signal:Vec<i16>=(0..length).map(|i|((i as f64*0.19).sin()*12000.0) as i16).collect();
   let output=processor.push(&signal,true).unwrap();assert_eq!(output.len(),signal.len());
   let energy=|data:&[i16]|data.iter().map(|v|(*v as f64).powi(2)).sum::<f64>();
   assert!(energy(&output)>energy(&signal)*0.1,"tail sound must leave the preprocessor overlap buffer, len={length}");
  }
 }
 #[test]
 fn stationary_noise_is_reduced_without_a_reference() {
  let mut near=Processor::new("dsp-noise",true,0).unwrap();let mut seed=31u32;
  let mut input_energy=0.0;let mut output_energy=0.0;
  for frame in 0..700 {
   let samples:Vec<i16>=(0..FRAME).map(|_|{seed=seed.wrapping_mul(1664525).wrapping_add(1013904223);((seed>>16) as i16)/8}).collect();
   let output=near.push(&samples,false).unwrap();
   if frame>400 {input_energy+=samples.iter().map(|v|(*v as f64).powi(2)).sum::<f64>();output_energy+=output.iter().map(|v|(*v as f64).powi(2)).sum::<f64>();}
  }
  assert!(output_energy<input_energy*0.5,"noise energy ratio {}",output_energy/input_energy);
 }
 #[test]
 fn echo_adapts_and_keeps_independent_near_speech() {
  let mut far=Processor::new("dsp-echo",false,0).unwrap();let mut near=Processor::new("dsp-echo",true,0).unwrap();
  let mut raw_energy=0.0;let mut clean_energy=0.0;let mut speech_energy=0.0;
  let mut seed=7u32;let mut history=VecDeque::from(vec![0i16;480]);
  for frame in 0..1200 {
   let reference:Vec<i16>=(0..FRAME).map(|_|{seed=seed.wrapping_mul(1664525).wrapping_add(1013904223);((seed>>16) as i16)/3}).collect();
   let captured:Vec<i16>=reference.iter().enumerate().map(|(i,value)|{
    history.push_back(*value);let echo=history.pop_front().unwrap() as f64*0.6;
    let voice=if frame>=900 {((frame*FRAME+i) as f64*0.061).sin()*5000.0}else{0.0};(echo+voice) as i16
   }).collect();
   far.push(&reference,false).unwrap();let output=near.push(&captured,false).unwrap();
   if (700..850).contains(&frame) {raw_energy+=captured.iter().map(|v|(*v as f64).powi(2)).sum::<f64>();clean_energy+=output.iter().map(|v|(*v as f64).powi(2)).sum::<f64>();}
   if frame>=1000 {speech_energy+=output.iter().map(|v|(*v as f64).powi(2)).sum::<f64>();}
  }
  assert!(clean_energy<raw_energy*0.2,"echo energy ratio {}",clean_energy/raw_energy);
  assert!(speech_energy/(200*FRAME) as f64>100_000.0,"near speech must remain audible");
 }
}
