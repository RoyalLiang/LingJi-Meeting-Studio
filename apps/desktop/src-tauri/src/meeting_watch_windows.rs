use ::windows::{
    core::{implement, Error, Interface, Ref, Result, PWSTR},
    Win32::{
        Foundation::{CloseHandle, E_FAIL, E_POINTER, HANDLE},
        Media::Audio::*,
        System::{
            Com::*,
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    },
};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

fn unavailable() -> Error {
    Error::from_hresult(E_FAIL)
}
struct Com;
impl Com {
    fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        }
        Ok(Self)
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct Process(HANDLE);
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
unsafe fn owned_string(value: PWSTR) -> Result<String> {
    if value.is_null() {
        return Err(Error::from_hresult(E_POINTER));
    }
    let result = value.to_string();
    CoTaskMemFree(Some(value.0.cast()));
    result.map_err(|_| unavailable())
}
fn process_path(pid: u32) -> Result<String> {
    unsafe {
        let process = Process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)?);
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )?;
        String::from_utf16(&buffer[..length as usize]).map_err(|_| unavailable())
    }
}
#[derive(Default)]
struct Pending {
    controls: Mutex<Vec<IAudioSessionControl>>,
    overflow: AtomicBool,
}
#[implement(IAudioSessionNotification)]
struct SessionCreated {
    pending: Arc<Pending>,
}
impl IAudioSessionNotification_Impl for SessionCreated_Impl {
    fn OnSessionCreated(&self, session: Ref<'_, IAudioSessionControl>) -> Result<()> {
        let session = session
            .as_ref()
            .ok_or_else(|| Error::from_hresult(E_POINTER))?;
        // Audio callbacks must not wait on the sampling thread or perform process queries.
        if let Ok(mut controls) = self.pending.controls.try_lock() {
            if controls.len() < 2048 {
                controls.push(session.clone());
                return Ok(());
            }
        }
        self.pending.overflow.store(true, Ordering::Release);
        Ok(())
    }
}
struct Endpoint {
    manager: IAudioSessionManager2,
    notification: IAudioSessionNotification,
    pending: Arc<Pending>,
    sessions: HashMap<String, IAudioSessionControl2>,
    input: bool,
    _device: IMMDevice,
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .manager
                .UnregisterSessionNotification(&self.notification);
        }
    }
}
impl Endpoint {
    fn new(device: IMMDevice, input: bool) -> Result<Self> {
        unsafe {
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let pending = Arc::new(Pending::default());
            let notification: IAudioSessionNotification = SessionCreated {
                pending: pending.clone(),
            }
            .into();
            manager.RegisterSessionNotification(&notification)?;
            let mut value = Self {
                manager,
                notification,
                pending,
                sessions: HashMap::new(),
                input,
                _device: device,
            };
            let enumerator = value.manager.GetSessionEnumerator()?;
            let count = enumerator.GetCount()?;
            if !(0..=4096).contains(&count) {
                return Err(unavailable());
            }
            for index in 0..count {
                value.add(enumerator.GetSession(index)?)?;
            }
            value.drain()?;
            Ok(value)
        }
    }
    fn add(&mut self, control: IAudioSessionControl) -> Result<()> {
        let session: IAudioSessionControl2 = control.cast()?;
        let id = unsafe { owned_string(session.GetSessionInstanceIdentifier()?)? };
        if self.sessions.len() >= 4096 && !self.sessions.contains_key(&id) {
            return Err(unavailable());
        }
        self.sessions.insert(id, session);
        Ok(())
    }
    fn drain(&mut self) -> Result<()> {
        if self.pending.overflow.swap(false, Ordering::AcqRel) {
            return Err(unavailable());
        }
        let controls =
            std::mem::take(&mut *self.pending.controls.lock().map_err(|_| unavailable())?);
        for control in controls {
            self.add(control)?;
        }
        Ok(())
    }
    fn sample(&mut self, browser: bool, feishu: bool) -> Result<bool> {
        self.drain()?;
        let mut active = false;
        let mut unknown = false;
        let mut expired = Vec::new();
        for (id, session) in &self.sessions {
            let state = unsafe { session.GetState() };
            match state {
                Ok(state) if state == AudioSessionStateExpired => {
                    expired.push(id.clone());
                }
                Ok(state) if state == AudioSessionStateInactive => {}
                Ok(state) if state == AudioSessionStateActive => {
                    let selected = (|| unsafe {
                        let mut pid = 0;
                        let status = (Interface::vtable(session).GetProcessId)(
                            Interface::as_raw(session),
                            &mut pid,
                        );
                        status.ok()?;
                        // A nonzero success only identifies the initial PID of a cross-process session.
                        if status.0 != 0 {
                            return Err(unavailable());
                        }
                        if pid == 0 || pid == std::process::id() {
                            return Ok(false);
                        }
                        Ok(super::selected_windows(
                            &process_path(pid)?,
                            browser,
                            feishu,
                        ))
                    })();
                    match selected {
                        Ok(true) => active = true,
                        Ok(false) => {}
                        Err(_) => unknown = true,
                    }
                }
                _ => unknown = true,
            }
        }
        for id in expired {
            self.sessions.remove(&id);
        }
        if unknown && !active {
            return Err(unavailable());
        }
        Ok(active)
    }
}
struct Sampler {
    enumerator: IMMDeviceEnumerator,
    endpoints: HashMap<String, Endpoint>,
    _com: Com,
}
impl Sampler {
    fn new() -> Result<Self> {
        let com = Com::new()?;
        let enumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
        Ok(Self {
            enumerator,
            endpoints: HashMap::new(),
            _com: com,
        })
    }
    fn sample(&mut self, browser: bool, feishu: bool) -> Result<(bool, bool)> {
        let mut present = HashSet::new();
        let mut topology_changed = false;
        for (flow, input) in [(eRender, false), (eCapture, true)] {
            let devices = match unsafe {
                self.enumerator
                    .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
            } {
                Ok(devices) => devices,
                Err(error) => {
                    self.endpoints.clear();
                    self.enumerator =
                        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
                    return Err(error);
                }
            };
            let count = unsafe { devices.GetCount()? };
            if count > 512 {
                return Err(unavailable());
            }
            for index in 0..count {
                let device = unsafe { devices.Item(index)? };
                let id = unsafe { owned_string(device.GetId()?)? };
                let key = format!("{}:{id}", flow.0);
                if !self.endpoints.contains_key(&key) {
                    self.endpoints
                        .insert(key.clone(), Endpoint::new(device, input)?);
                    topology_changed = true;
                }
                present.insert(key);
            }
        }
        topology_changed |= present.len() != self.endpoints.len();
        self.endpoints.retain(|key, _| present.contains(key));
        if self.endpoints.is_empty() {
            return Err(unavailable());
        }
        let mut input = false;
        let mut output = false;
        let mut unknown = topology_changed;
        let mut broken = Vec::new();
        for (key, endpoint) in &mut self.endpoints {
            match endpoint.sample(browser, feishu) {
                Ok(true) => {
                    if endpoint.input {
                        input = true;
                    } else {
                        output = true;
                    }
                }
                Ok(false) => {}
                Err(_) => {
                    unknown = true;
                    broken.push(key.clone());
                }
            }
        }
        for key in broken {
            self.endpoints.remove(&key);
        }
        if unknown && !input && !output {
            return Err(unavailable());
        }
        // shortcut: WASAPI exposes shared sessions; exclusive streams need an independent meeting signal.
        Ok((input, output))
    }
}
thread_local! {static SAMPLER:RefCell<Option<Sampler>>=const{RefCell::new(None)};}
pub(super) fn sample(browser: bool, feishu: bool) -> std::result::Result<(bool, bool), String> {
    SAMPLER.with(|cell| {
        let mut sampler = cell.borrow_mut();
        if sampler.is_none() {
            *sampler = Some(Sampler::new().map_err(|_| "audio_activity_unavailable")?);
        }
        sampler
            .as_mut()
            .unwrap()
            .sample(browser, feishu)
            .map_err(|_| "audio_activity_unavailable".into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn null_session_callback_is_rejected_without_retaining_a_pointer() {
        let pending = Arc::new(Pending::default());
        let notification: IAudioSessionNotification = SessionCreated {
            pending: pending.clone(),
        }
        .into();
        let error =
            unsafe { notification.OnSessionCreated(None::<&IAudioSessionControl>) }.unwrap_err();
        assert_eq!(error.code(), E_POINTER);
        assert!(pending.controls.lock().unwrap().is_empty());
        assert!(!pending.overflow.load(Ordering::Acquire));
    }
    #[test]
    fn real_windows_sampler_reports_activity_or_unavailability_without_opening_streams() {
        let result = super::sample(true, true);
        SAMPLER.with(|cell| {
            let sampler = cell.borrow();
            let endpoints = sampler
                .as_ref()
                .map_or(0, |sampler| sampler.endpoints.len());
            eprintln!("meeting-watch read-only endpoints={endpoints} result={result:?}");
            if endpoints == 0 {
                assert_eq!(result, Err("audio_activity_unavailable".into()));
            }
        });
    }
}
