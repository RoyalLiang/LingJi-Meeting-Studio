use serde::Serialize;
#[cfg(target_os="macos")]
pub mod macos;
#[cfg(target_os="windows")]
pub mod windows;

#[derive(Clone,Debug,PartialEq,Eq)]
pub struct Target {pub pid:u32,pub started:String}
impl Target {
 pub fn parse(value:&str)->Result<Self,String>{
  let parts:Vec<_>=value.split(':').collect();
  if parts.len()!=3||parts[0]!="app"||parts[1].is_empty()||parts[2].is_empty()||parts[2].len()>24||!parts[1].bytes().all(|v|v.is_ascii_digit())||!parts[2].bytes().all(|v|v.is_ascii_digit()){return Err("所选应用标识无效，请重新选择应用。".into());}
  let pid=parts[1].parse::<u32>().map_err(|_|"所选应用标识无效，请重新选择应用。")?;
  if pid==0{return Err("所选应用标识无效，请重新选择应用。".into());}
  Ok(Self{pid,started:parts[2].into()})
 }
 pub fn id(&self)->String{format!("app:{}:{}",self.pid,self.started)}
}
#[derive(Serialize)]
pub struct Application {pub id:String,pub label:String}
fn distinguish_instances(applications:&mut [Application]) {
 let mut counts=std::collections::BTreeMap::new();for app in applications.iter(){*counts.entry(app.label.clone()).or_insert(0)+=1;}
 for app in applications.iter_mut(){if counts.get(&app.label).is_some_and(|count|*count>1){if let Some(pid)=app.id.split(':').nth(1){app.label=format!("{} · 进程 {pid}",app.label);}}}
}
#[derive(Serialize)]
pub struct Applications {pub supported:bool,pub applications:Vec<Application>,pub reason:Option<String>}
pub fn list()->Result<Applications,String>{
 #[cfg(target_os="macos")] {return macos::list();}
 #[cfg(target_os="windows")] {return windows::list();}
 #[cfg(not(any(target_os="macos",target_os="windows")))] {Ok(Applications{supported:false,applications:Vec::new(),reason:Some("此系统暂不支持按应用选择声音。".into())})}
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn identity_never_turns_a_missing_application_into_system_audio(){
  assert_eq!(Target::parse("app:123:1700000000000012").unwrap().id(),"app:123:1700000000000012");
  for value in ["system","app:0:1","app:-1:1","app:1:","app:1:1:extra","app:4294967296:1","app:1:abc","app:1:1234567890123456789012345"] {assert!(Target::parse(value).is_err());}
 }
}
