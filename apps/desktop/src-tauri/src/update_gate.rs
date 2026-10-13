use serde::Deserialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activity {
    pub authenticated: bool,
    pub recording: bool,
    pub paused: bool,
    pub busy: bool,
    pub queue_busy: bool,
    pub pending_bytes: u64,
    pub pending_count: u64,
}

impl Activity {
    pub fn reason(&self) -> Option<&'static str> {
        if !self.authenticated {
            Some("请先登录，核对录音与补传状态后安装更新")
        } else if self.recording {
            Some("正在录音，更新将在本场结束后安装")
        } else if self.paused {
            Some("本场处于暂停状态，请结束会议后安装更新")
        } else if self.busy || self.queue_busy {
            Some("正在保存或处理本地音频，请稍后安装更新")
        } else if self.pending_bytes != 0 || self.pending_count != 0 {
            Some("本机仍有待传音频，请补传完成后安装更新")
        } else {
            None
        }
    }
}

#[derive(Default)]
struct State {
    activity: Activity,
    reported: Option<Instant>,
    generation: u64,
    starting: usize,
    installing: bool,
}

#[derive(Clone, Default)]
pub struct Gate(Arc<Mutex<State>>);
pub struct CapturePermit(Gate);
pub struct InstallPermit {
    gate: Gate,
    generation: u64,
}

impl Gate {
    pub fn report(&self, activity: Activity) {
        let mut state = self.0.lock().unwrap();
        if state.activity != activity {
            state.generation += 1;
        }
        state.activity = activity;
        state.reported = Some(Instant::now());
    }
    pub fn capture(&self) -> Result<CapturePermit, String> {
        let mut state = self.0.lock().unwrap();
        if state.installing {
            return Err("正在安装更新，暂时不能开启录音".into());
        }
        state.starting += 1;
        state.generation += 1;
        Ok(CapturePermit(self.clone()))
    }
    pub fn installing(&self) -> bool {
        self.0.lock().unwrap().installing
    }
    pub fn fresh(&self) -> bool {
        self.0
            .lock()
            .unwrap()
            .reported
            .is_some_and(|time| time.elapsed() <= Duration::from_secs(4))
    }
    fn state_reason(state: &State, native_active: bool) -> Option<&'static str> {
        if state.installing || state.starting != 0 || native_active {
            Some("原生音源尚未释放，不能安装更新")
        } else if state
            .reported
            .is_none_or(|time| time.elapsed() > Duration::from_secs(4))
        {
            Some("会议页面状态已过期，请回到页面后重试")
        } else {
            state.activity.reason()
        }
    }
    pub fn reason(&self, native_active: bool) -> Option<&'static str> {
        Self::state_reason(&self.0.lock().unwrap(), native_active)
    }
    pub fn install(&self, native_active: bool) -> Result<InstallPermit, String> {
        let mut state = self.0.lock().unwrap();
        if let Some(reason) = Self::state_reason(&state, native_active) {
            return Err(reason.into());
        }
        state.installing = true;
        Ok(InstallPermit {
            gate: self.clone(),
            generation: state.generation,
        })
    }
}

impl InstallPermit {
    pub fn validate(&self, native_active: bool) -> Result<(), String> {
        let state = self.gate.0.lock().unwrap();
        if native_active
            || state.starting != 0
            || state.generation != self.generation
            || state.activity.reason().is_some()
        {
            Err("会议状态已变化，已取消本次安装；已下载更新仍保留".into())
        } else {
            Ok(())
        }
    }
}
impl Drop for CapturePermit {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap().starting -= 1;
    }
}
impl Drop for InstallPermit {
    fn drop(&mut self) {
        self.gate.0.lock().unwrap().installing = false;
    }
}

pub fn server_record_safe(record: &serde_json::Value) -> Result<(), String> {
    let state = record["capture"].as_str().ok_or("服务端会议状态不完整")?;
    if ["recording", "paused"].contains(&state) {
        return Err("仍有录音中或暂停待继续的会议，请先结束会议".into());
    }
    let sources = record["sources"].as_array().ok_or("服务端音源状态不完整")?;
    for source in sources {
        let last = source["lastSequence"]
            .as_i64()
            .ok_or("音源停止清单尚未确认")?;
        let watermark = source["watermark"]
            .as_i64()
            .ok_or("音频持久化确认尚未完成")?;
        if source["stopped"].as_bool() != Some(true) || watermark < last {
            return Err("音源尾包或服务端持久化确认尚未完成".into());
        }
    }
    if !["idle", "sealed", "completed"].contains(&state) {
        return Err("服务端会议尚未进入安全停止状态".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn idle() -> Activity {
        Activity {
            authenticated: true,
            ..Default::default()
        }
    }
    #[test]
    fn rejects_every_unsafe_state_and_stale_renderer() {
        let gate = Gate::default();
        assert!(gate.install(false).is_err());
        for activity in [
            Activity::default(),
            Activity {
                recording: true,
                ..idle()
            },
            Activity {
                paused: true,
                ..idle()
            },
            Activity {
                busy: true,
                ..idle()
            },
            Activity {
                queue_busy: true,
                ..idle()
            },
            Activity {
                pending_count: 1,
                ..idle()
            },
            Activity {
                pending_bytes: 1,
                ..idle()
            },
        ] {
            gate.report(activity);
            assert!(gate.install(false).is_err());
        }
        gate.report(idle());
        gate.0.lock().unwrap().reported = Some(Instant::now() - Duration::from_secs(5));
        assert!(gate.install(false).is_err());
    }
    #[test]
    fn install_and_permission_start_are_mutually_exclusive_and_changes_cancel_install() {
        let gate = Gate::default();
        gate.report(idle());
        let capture = gate.capture().unwrap();
        assert!(gate.install(false).is_err());
        drop(capture);
        assert!(gate.install(true).is_err());
        let install = gate.install(false).unwrap();
        assert!(gate.capture().is_err());
        gate.report(idle());
        assert!(install.validate(false).is_ok());
        gate.report(Activity {
            pending_bytes: 4,
            ..idle()
        });
        assert!(install.validate(false).is_err());
        drop(install);
        assert!(gate.capture().is_ok());
    }
    #[test]
    fn backend_watermark_and_stop_manifest_are_required_but_llm_completion_is_not() {
        let mut record = serde_json::json!({"capture":"sealed","sources":[{"stopped":true,"watermark":4,"lastSequence":4}],"transcription":"queued"});
        assert!(server_record_safe(&record).is_ok());
        for state in ["recording", "paused", "unknown"] {
            record["capture"] = state.into();
            assert!(server_record_safe(&record).is_err());
        }
        record["capture"] = "sealed".into();
        record["sources"][0]["watermark"] = 3.into();
        assert!(server_record_safe(&record).is_err());
        record["sources"][0]["watermark"] = 4.into();
        record["sources"][0]["stopped"] = false.into();
        assert!(server_record_safe(&record).is_err());
        assert!(server_record_safe(&serde_json::json!({"capture":"idle","sources":[]})).is_ok());
        assert!(server_record_safe(&serde_json::json!({"capture":"sealed"})).is_err());
    }
}
