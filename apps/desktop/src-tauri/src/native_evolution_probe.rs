use crate::Client;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use std::time::{Duration, Instant};

async fn record(app: &AppHandle, id: &str) -> Result<Value, String> {
    app.state::<Client>().api.evolution_probe_request(&format!("/api/records/{id}"), None).await
}
async fn run(app: &AppHandle) -> Result<Value, String> {
    let created=app.state::<Client>().api.evolution_probe_request("/api/records",Some(json!({"title":"Native evolution synthetic smoke","autoMinutes":false}))).await?;
    let id=created["id"].as_str().ok_or("测试记录未创建")?.to_string();
    let window=app.get_webview_window("main").ok_or("测试主窗口缺失")?;
    for kind in ["display","microphone"] {
        crate::capture_direct_start(window.clone(),app.state::<Client>(),id.clone(),kind.into(),None).await?;
    }
    if !app.state::<Client>().captures.native_status().is_some_and(|status| status.recording && status.microphone_on) { return Err("双音源未启动".into()); }
    window.destroy().map_err(|error|error.to_string())?;
    tokio::time::sleep(Duration::from_millis(2600)).await;
    if app.get_webview_window("main").is_some() { return Err("主窗口未销毁".into()); }
    let before=app.state::<Client>().captures.native_status().ok_or("原生状态丢失")?;
    if !before.recording || before.duration_ms < 900 { return Err("无主窗口时采集未继续".into()); }
    if !crate::recording_widget::native_action(app,"toggle").await? { return Err("无主窗口暂停未接管".into()); }
    let deadline=Instant::now()+Duration::from_secs(15);
    loop {
        let value=record(app,&id).await?;
        if value["capture"]=="paused" && value["sources"].as_array().is_some_and(|sources|sources.iter().all(|source|source["watermark"]==source["lastSequence"])) { break; }
        if Instant::now()>deadline { return Err("本机持久化确认超时".into()); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let paused=app.state::<Client>().captures.native_status().ok_or("暂停状态丢失")?;
    if !paused.paused || !paused.can_resume { return Err("暂停尾部未排空".into()); }
    app.state::<Client>().resident.queue_action("status-resume");
    crate::resident::show(app);
    let deadline=Instant::now()+Duration::from_secs(30);
    loop {
        let resumed=app.state::<Client>().captures.native_status().is_some_and(|status|status.recording && status.microphone_on);
        if app.get_webview_window("main").is_some() && app.state::<Client>().resident.renderer_ready() && resumed { break; }
        if Instant::now()>deadline {
            return Err(format!("主窗口重建或页面恢复录制超时: window={}, ready={}",app.get_webview_window("main").is_some(),app.state::<Client>().resident.renderer_ready()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(350)).await;
    let captures=app.state::<Client>().captures.clone(); let record_id=id.clone();
    tauri::async_runtime::spawn_blocking(move||captures.stop_record(&record_id,"seal")).await.map_err(|error|error.to_string())??;
    let deadline=Instant::now()+Duration::from_secs(15);
    let final_record=loop {
        let value=record(app,&id).await?;
        if ["sealed","completed"].iter().any(|capture|value["capture"]==*capture) && value["sources"].as_array().is_some_and(|sources|sources.len()==4 && sources.iter().all(|source|source["watermark"]==source["lastSequence"])) { break value; }
        if Instant::now()>deadline { return Err("结束后的四音源未全部排空".into()); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    Ok(json!({"ok":true,"recordId":id,"syntheticOnly":true,"destroyedMainWindow":true,"continuedWithoutRenderer":true,"nativePauseWithoutRenderer":true,"mainWindowRecreated":true,"reactRestoredAndResumed":true,"durableFinalFences":true,"sources":final_record["sources"]}))
}
pub async fn execute(app: AppHandle) {
    let result=match run(&app).await { Ok(value)=>value,Err(error)=>json!({"ok":false,"error":error}) };
    if let Ok(path)=std::env::var("TTS_CLIENT_PROBE_OUTPUT") { let _=std::fs::write(path,result.to_string()); }
    crate::resident::probe_exit(&app);
}
