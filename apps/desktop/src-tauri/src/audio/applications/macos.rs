use super::{Application,Applications,Target};
use std::{collections::BTreeMap,ffi::{c_void,CStr},mem::size_of,ptr::NonNull,time::{Duration,Instant}};
use objc2::{rc::Retained,AnyThread};
use objc2_core_audio::*;
use objc2_core_foundation::{kCFAllocatorDefault,kCFTypeArrayCallBacks,kCFTypeDictionaryKeyCallBacks,kCFTypeDictionaryValueCallBacks,CFArray,CFDictionary,CFMutableDictionary,CFRetained,CFString};
use objc2_foundation::{NSArray,NSNumber,NSString};
use objc2_app_kit::{NSWorkspace,NSApplicationActivationPolicy};
use cpal::traits::{HostTrait,DeviceTrait};

fn info(pid:u32)->Option<libc::proc_bsdinfo>{
 let mut value=std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
 let count=unsafe{libc::proc_pidinfo(pid as i32,libc::PROC_PIDTBSDINFO,0,value.as_mut_ptr().cast(),size_of::<libc::proc_bsdinfo>() as i32)};
 if count!=size_of::<libc::proc_bsdinfo>() as i32{return None;}Some(unsafe{value.assume_init()})
}
fn target(pid:u32)->Option<Target>{let value=info(pid)?;if value.pbi_uid!=unsafe{libc::geteuid()}{return None;}Some(Target{pid,started:format!("{}{:06}",value.pbi_start_tvsec,value.pbi_start_tvusec)})}
fn alive(selected:&Target)->Result<(),String>{if target(selected.pid).as_ref()!=Some(selected){return Err("所选应用已退出或重新启动，请重新选择应用。".into());}Ok(())}
pub fn list()->Result<Applications,String>{
 let mut apps=BTreeMap::new();
 for app in NSWorkspace::sharedWorkspace().runningApplications().iter(){
  let pid=app.processIdentifier();if pid<=0||pid as u32==std::process::id()||app.activationPolicy()!=NSApplicationActivationPolicy::Regular {continue;}
  if let (Some(selected),Some(name))=(target(pid as u32),app.localizedName()){apps.insert(selected.pid,Application{id:selected.id(),label:name.to_string()});}
 }
 let mut applications:Vec<_>=apps.into_values().collect();super::distinguish_instances(&mut applications);applications.sort_by(|a,b|a.label.cmp(&b.label));applications.truncate(256);
 Ok(Applications{supported:true,applications,reason:None})
}
fn property(selector:AudioObjectPropertySelector)->AudioObjectPropertyAddress{AudioObjectPropertyAddress{mSelector:selector,mScope:kAudioObjectPropertyScopeGlobal,mElement:kAudioObjectPropertyElementMain}}
fn objects()->Result<Vec<AudioObjectID>,String>{
 let address=property(kAudioHardwarePropertyProcessObjectList);let mut bytes=0;
 let status=unsafe{AudioObjectGetPropertyDataSize(kAudioObjectSystemObject as u32,NonNull::from(&address),0,std::ptr::null(),NonNull::from(&mut bytes))};check(status)?;
 if bytes>65536||bytes as usize%size_of::<AudioObjectID>()!=0{return Err("应用声音列表无效，请重试。".into());}
 let mut result=vec![0;bytes as usize/size_of::<AudioObjectID>()];
 if bytes>0 {check(unsafe{AudioObjectGetPropertyData(kAudioObjectSystemObject as u32,NonNull::from(&address),0,std::ptr::null(),NonNull::from(&mut bytes),NonNull::new(result.as_mut_ptr().cast()).unwrap())})?;result.truncate(bytes as usize/size_of::<AudioObjectID>());}
 Ok(result)
}
fn descendants(selected:&Target)->Result<Vec<AudioObjectID>,String>{
 alive(selected)?;let mut result=Vec::new();let mut parents=BTreeMap::new();
 for object in objects()? {
  let mut pid=0u32;let mut bytes=size_of::<u32>() as u32;let address=property(kAudioProcessPropertyPID);
  if unsafe{AudioObjectGetPropertyData(object,NonNull::from(&address),0,std::ptr::null(),NonNull::from(&mut bytes),NonNull::from(&mut pid).cast())}!=0{continue;}
  let mut current=pid;
  for _ in 0..32 {if current==selected.pid {result.push(object);break;}if current<=1{break;}let Some(parent)=*parents.entry(current).or_insert_with(||info(current).map(|value|value.pbi_ppid))else{break;};if parent==current{break;}current=parent;}
 }
 result.sort_unstable();result.dedup();alive(selected)?;Ok(result)
}
fn check(status:i32)->Result<(),String>{if status==0{Ok(())}else{Err(format!("无法接入所选应用声音，请检查音频权限后重试（{status}）。"))}}
fn numbers(ids:&[AudioObjectID])->Retained<NSArray<NSNumber>>{NSArray::from_retained_slice(&ids.iter().map(|id|NSNumber::new_u32(*id)).collect::<Vec<_>>())}

pub struct Tap {selected:Target,description:Retained<CATapDescription>,tap:AudioObjectID,aggregate:AudioObjectID,ids:Vec<AudioObjectID>,checked:Instant}
impl Tap {
 pub fn open(host:&cpal::Host,selected:Target)->Result<(cpal::Device,Self,String),String>{
  alive(&selected)?;let ids=descendants(&selected)?;
  let description=unsafe{CATapDescription::initStereoMixdownOfProcesses(CATapDescription::alloc(),&numbers(&ids))};
  unsafe{description.setPrivate(true);description.setExclusive(false);description.setMuteBehavior(CATapMuteBehavior::Unmuted);description.setName(&NSString::from_str("Lingji selected application"));}
  let mut guard=Self{selected,description,tap:0,aggregate:0,ids,checked:Instant::now()};
  check(unsafe{AudioHardwareCreateProcessTap(Some(&guard.description),&mut guard.tap)})?;
  let uid=format!("com.lingji.application.{}.{}",std::process::id(),guard.tap);
  let properties=create_audio_aggregate_device_properties(unsafe{guard.description.UUID().UUIDString()},&uid,"Lingji selected application");
  check(unsafe{AudioHardwareCreateAggregateDevice(&properties,NonNull::from(&mut guard.aggregate))})?;
  let device=host.device_by_id(&cpal::DeviceId::new(cpal::HostId::CoreAudio,uid)).ok_or("无法打开所选应用音源，请播放应用声音后重试。")?;
  let _=device.default_input_config().map_err(|_|"所选应用音频格式不可用，请播放声音后重试。")?;
  let label=list()?.applications.into_iter().find(|app|app.id==guard.selected.id()).map(|app|app.label).unwrap_or_else(||"所选应用".into());
  Ok((device,guard,format!("应用声音 · {label}")))
 }
 pub fn refresh(&mut self)->Result<(),String>{
  if self.checked.elapsed()<Duration::from_secs(1){return Ok(());}self.checked=Instant::now();
  let ids=descendants(&self.selected)?;if ids==self.ids{return Ok(());}
  unsafe{self.description.setProcesses(&numbers(&ids));self.description.setExclusive(false);}
  let description=&*self.description as *const CATapDescription;
  check(unsafe{AudioObjectSetPropertyData(self.tap,NonNull::from(&property(kAudioTapPropertyDescription)),0,std::ptr::null(),size_of::<*const CATapDescription>() as u32,NonNull::from(&description).cast())})?;self.ids=ids;Ok(())
 }
}
impl Drop for Tap {fn drop(&mut self){unsafe{if self.aggregate!=0{let _=AudioHardwareDestroyAggregateDevice(self.aggregate);}if self.tap!=0{let _=AudioHardwareDestroyProcessTap(self.tap);}}}}

// Aggregate-property builder adapted from CPAL 0.18.2 (Apache-2.0); see bundled CPAL-COPYING.
fn to_cfstring(cstr: &'static CStr) -> CFRetained<CFString> {
    unsafe {
        CFString::with_c_string(
            kCFAllocatorDefault,
            cstr.as_ptr(),
            0x08000100, /* UTF8 */
        )
    }
    .unwrap()
}

/// Rust reimplementation of the following:
/// ```c
/// tap_uid = [[tap_description UUID] UUIDString];
/// taps = @[
///     @{
///         @kAudioSubTapUIDKey : (NSString*)tap_uid,
///         @kAudioSubTapDriftCompensationKey : @YES,
///     },
/// ];
///
/// aggregate_device_properties = @{
///     @kAudioAggregateDeviceNameKey : @"MiniMetersAggregateDevice",
///     @kAudioAggregateDeviceUIDKey :
///         @"com.josephlyncheski.MiniMetersAggregateDevice",
///     @kAudioAggregateDeviceTapListKey : taps,
///     @kAudioAggregateDeviceTapAutoStartKey : @YES,
///     @kAudioAggregateDeviceIsPrivateKey : @YES,
/// };
/// ```
pub fn create_audio_aggregate_device_properties(
    tap_uid: Retained<NSString>,
    agg_uid: &str,
    agg_name: &str,
) -> CFRetained<CFDictionary> {
    let tap_inner = unsafe {
        let dict = CFMutableDictionary::new(
            kCFAllocatorDefault,
            2,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .unwrap();

        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioSubTapUIDKey) as *const _ as *const c_void,
            &*tap_uid as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioSubTapDriftCompensationKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );

        dict
    };
    let _taps_list = [tap_inner];
    let taps = unsafe {
        CFArray::new(
            kCFAllocatorDefault,
            _taps_list.as_ptr() as *mut *const c_void,
            _taps_list.len() as _,
            &kCFTypeArrayCallBacks,
        )
        .unwrap()
    };
    let aggregate_dev_properties = unsafe {
        let dict = CFMutableDictionary::new(
            kCFAllocatorDefault,
            5,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .unwrap();

        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceNameKey) as *const _ as *const c_void,
            &*CFString::from_str(agg_name) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceUIDKey) as *const _ as *const c_void,
            &*CFString::from_str(agg_uid) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceTapListKey) as *const _ as *const c_void,
            &*taps as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceTapAutoStartKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioEndPointDeviceIsPrivateKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );

        CFRetained::cast_unchecked::<CFDictionary>(dict)
    };

    aggregate_dev_properties
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn process_identity_is_stable_and_reused_pid_cannot_broaden_the_tap(){
  let current=target(std::process::id()).unwrap();assert_eq!(target(current.pid),Some(current.clone()));assert!(alive(&current).is_ok());
  let stale=Target{pid:current.pid,started:format!("{}0",current.started)};assert!(alive(&stale).is_err());assert!(descendants(&stale).is_err());
  let host=cpal::default_host();assert!(Tap::open(&host,stale).is_err());
 }
}
