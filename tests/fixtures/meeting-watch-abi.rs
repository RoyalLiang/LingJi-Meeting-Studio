use std::{ffi::c_void,sync::atomic::{AtomicU32,Ordering}};
static FAULT:AtomicU32=AtomicU32::new(0);
static RELEASES:AtomicU32=AtomicU32::new(0);
#[no_mangle]
unsafe extern "C" fn AudioObjectGetPropertyDataSize(_object:u32,_address:*const c_void,_qs:u32,_q:*const c_void,size:*mut u32)->i32{*size=4;0}
#[no_mangle]
unsafe extern "C" fn AudioObjectGetPropertyData(_object:u32,address:*const c_void,_qs:u32,_q:*const c_void,size:*mut u32,data:*mut c_void)->i32{
 let selector=*(address as *const u32);let fault=FAULT.load(Ordering::SeqCst);
 if selector==u32::from_be_bytes(*b"prs#"){if fault==6{return -1;}*(data as *mut u32)=42;*size=4;return 0;}
 if selector==u32::from_be_bytes(*b"ppid"){if fault==1{return -1;}*(data as *mut i32)=if fault==8{0}else{i32::MAX};*size=4;return 0;}
 if selector==u32::from_be_bytes(*b"pbid"){if fault==2{return -1;}*(data as *mut *const c_void)=std::ptr::dangling::<u8>().cast();*size=std::mem::size_of::<*const c_void>() as u32;return 0;}
 if selector==u32::from_be_bytes(*b"piri") || selector==u32::from_be_bytes(*b"piro"){
  if (fault==4 && selector==u32::from_be_bytes(*b"piri")) || (fault==5 && selector==u32::from_be_bytes(*b"piro")){return -1;}
  *(data as *mut u32)=u32::from(selector==u32::from_be_bytes(*b"piri"));*size=if fault==7{1}else{4};return 0;
 }
 -1
}
#[no_mangle]
unsafe extern "C" fn CFStringGetCString(_value:*const c_void,buffer:*mut i8,_size:isize,_encoding:u32)->u8{
 if FAULT.load(Ordering::SeqCst)==3{return 0;}
 let name=b"com.google.Chrome\0";std::ptr::copy_nonoverlapping(name.as_ptr().cast::<i8>(),buffer,name.len());1
}
#[no_mangle]
extern "C" fn CFRelease(_value:*const c_void){RELEASES.fetch_add(1,Ordering::SeqCst);}
fn main(){
 assert_eq!(macos::sample(true,false).unwrap(),(true,false));assert_eq!(RELEASES.load(Ordering::SeqCst),1);
 for fault in 1..=8{FAULT.store(fault,Ordering::SeqCst);let result=macos::sample(true,true);assert!(result.is_err(),"unknown metadata/property must not become inactive: fault={fault}, result={result:?}");}
 FAULT.store(3,Ordering::SeqCst);RELEASES.store(0,Ordering::SeqCst);assert!(macos::sample(true,true).is_err());assert_eq!(RELEASES.load(Ordering::SeqCst),1,"the returned bundle must be released on conversion failure");
}
