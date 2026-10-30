use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct MeetingWatch {
    generation: Arc<AtomicU64>,
    token: Mutex<Option<String>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Signal {
    token: String,
    sampled_at: u64,
    input: bool,
    output: bool,
    error: Option<String>,
}
impl MeetingWatch {
    pub fn configure(
        &self,
        app: AppHandle,
        enabled: bool,
        browser: bool,
        feishu: bool,
        token: String,
    ) -> Result<bool, String> {
        if !cfg!(target_os = "macos") {
            return Ok(false);
        }
        let mut current = self.token.lock().map_err(|_| "监听状态不可用")?;
        if !enabled {
            if current.as_deref() == Some(&token) {
                self.generation.fetch_add(1, Ordering::SeqCst);
                *current = None;
            }
            return Ok(true);
        }
        if token.is_empty() || token.len() > 80 || (!browser && !feishu) {
            return Err("请选择监听目标".into());
        }
        *current = Some(token.clone());
        let version = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let generation = self.generation.clone();
        std::thread::spawn(move || {
            while generation.load(Ordering::SeqCst) == version {
                let result = sample(browser, feishu);
                let (input, output, error) = match result {
                    Ok((input, output)) => (input, output, None),
                    Err(_) => (false, false, Some("audio_activity_unavailable".into())),
                };
                let sampled_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                if generation.load(Ordering::SeqCst) != version {
                    break;
                }
                let _ = app.emit_to(
                    "main",
                    "meeting-activity",
                    Signal {
                        token: token.clone(),
                        sampled_at,
                        input,
                        output,
                        error,
                    },
                );
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        });
        Ok(true)
    }
}
fn selected(bundle: &str, browser: bool, feishu: bool) -> bool {
    const BROWSERS: &[&str] = &[
        "com.google.Chrome",
        "com.google.Chrome.helper",
        "com.google.Chrome.helper.renderer",
        "com.microsoft.edgemac",
        "com.microsoft.edgemac.helper",
        "com.microsoft.edgemac.helper.renderer",
    ];
    const FEISHU: &[&str] = &[
        "com.electron.lark",
        "com.electron.lark.helper",
        "com.electron.lark.helper.renderer",
        "com.electron.lark.helper.plugin",
        "com.electron.lark.iron",
    ];
    (browser && BROWSERS.contains(&bundle)) || (feishu && FEISHU.contains(&bundle))
}
#[cfg(not(target_os = "macos"))]
fn sample(_browser: bool, _feishu: bool) -> Result<(bool, bool), String> {
    Err("unsupported".into())
}
#[cfg(target_os = "macos")]
fn sample(browser: bool, feishu: bool) -> Result<(bool, bool), String> {
    macos::sample(browser, feishu)
}

#[cfg(target_os = "macos")]
mod macos {
    use std::{ffi::c_void, ptr::null};
    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }
    type Ref = *const c_void;
    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
        ) -> i32;
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetCString(value: Ref, buffer: *mut i8, size: isize, encoding: u32) -> u8;
        fn CFRelease(value: Ref);
    }
    fn address(selector: [u8; 4]) -> Address {
        Address {
            selector: u32::from_be_bytes(selector),
            scope: u32::from_be_bytes(*b"glob"),
            element: 0,
        }
    }
    unsafe fn property<T: Default>(object: u32, selector: [u8; 4]) -> Result<T, String> {
        let mut value = T::default();
        let mut size = std::mem::size_of::<T>() as u32;
        let status = AudioObjectGetPropertyData(
            object,
            &address(selector),
            0,
            null(),
            &mut size,
            (&mut value as *mut T).cast(),
        );
        if status != 0 || size as usize != std::mem::size_of::<T>() {
            return Err("audio_property_unavailable".into());
        }
        Ok(value)
    }
    pub fn sample(browser: bool, feishu: bool) -> Result<(bool, bool), String> {
        unsafe {
            let mut size = 0;
            if AudioObjectGetPropertyDataSize(1, &address(*b"prs#"), 0, null(), &mut size) != 0
                || size % 4 != 0
                || size > 1024 * 1024
            {
                return Err("audio_processes_unavailable".into());
            }
            let mut objects = vec![0u32; size as usize / 4];
            if AudioObjectGetPropertyData(
                1,
                &address(*b"prs#"),
                0,
                null(),
                &mut size,
                objects.as_mut_ptr().cast(),
            ) != 0
                || size % 4 != 0
                || size as usize > objects.len() * 4
            {
                return Err("audio_processes_unavailable".into());
            }
            objects.truncate(size as usize / 4);
            let (mut input, mut output) = (false, false);
            for object in objects {
                let pid = property::<i32>(object, *b"ppid")?;
                if pid <= 0 {
                    return Err("audio_process_identity_unavailable".into());
                }
                if pid as u32 == std::process::id() {
                    continue;
                }
                let mut bundle: Ref = null();
                let mut bytes = std::mem::size_of::<Ref>() as u32;
                if AudioObjectGetPropertyData(
                    object,
                    &address(*b"pbid"),
                    0,
                    null(),
                    &mut bytes,
                    (&mut bundle as *mut Ref).cast(),
                ) != 0
                    || bundle.is_null()
                {
                    return Err("audio_bundle_unavailable".into());
                }
                let mut name = [0i8; 1024];
                let valid =
                    CFStringGetCString(bundle, name.as_mut_ptr(), name.len() as isize, 0x0800_0100)
                        != 0;
                // CoreAudio transfers ownership of the bundle CFString to the caller.
                CFRelease(bundle);
                if !valid {
                    return Err("audio_bundle_unavailable".into());
                }
                let id = std::ffi::CStr::from_ptr(name.as_ptr()).to_string_lossy();
                if !super::selected(&id, browser, feishu) {
                    continue;
                }
                input |= property::<u32>(object, *b"piri")? != 0;
                output |= property::<u32>(object, *b"piro")? != 0;
            }
            Ok((input, output))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn targets_exclude_self_safari_and_notification_helpers() {
        assert!(selected("com.google.Chrome.helper", true, false));
        assert!(selected("com.electron.lark.helper.renderer", false, true));
        assert!(!selected("com.google.Chrome.helper", false, true));
        for id in [
            "com.citrolabs.ego.lite",
            "com.apple.WebKit.WebContent",
            "com.google.Chrome.framework.AlertNotificationService",
            "com.electron.lark-spoof",
        ] {
            assert!(!selected(id, true, true));
        }
    }
}
