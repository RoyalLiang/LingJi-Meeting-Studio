use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub authenticated: bool,
    pub record_title: String,
    pub capture: String,
    pub recording: bool,
    pub busy: bool,
    pub pending_count: u64,
    pub connection: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Presentation {
    pub title: String,
    pub record: String,
    pub status: String,
    pub connection: String,
    pub queue: String,
    pub pause: bool,
    pub resume: bool,
    pub finish: bool,
    pub settings: bool,
}

pub fn present(report: &Report, native_active: bool, fresh: bool) -> Presentation {
    let safe = report.authenticated && fresh && !report.busy;
    let recording = native_active || report.recording;
    let (title, status) = if native_active && !fresh {
        ("录音", "正在记录 · 页面状态待确认")
    } else if !fresh {
        ("待确认", "页面状态待确认，请打开聆记")
    } else if recording {
        ("录音", "正在记录")
    } else if report.capture == "paused" {
        ("暂停", "本场已暂停")
    } else if report.pending_count > 0 {
        ("补传", "正在等待音频补传")
    } else if !report.authenticated {
        ("", "请先登录")
    } else {
        ("", "待开始记录")
    };
    let name: String = report
        .record_title
        .chars()
        .filter(|c| !c.is_control())
        .take(36)
        .collect();
    let connection = match report.connection.as_str() {
        "connected" => "后台已连接",
        "connecting" => "正在连接后台",
        "reconnecting" => "正在重新连接",
        "offline" => "当前离线 · 本地音频保留",
        "unavailable" => "后台连接不可用",
        _ => "后台状态待确认",
    };
    Presentation {
        title: title.into(),
        record: if name.is_empty() {
            "未选择会议".into()
        } else {
            format!("会议：{name}")
        },
        status: status.into(),
        connection: if fresh {
            connection.into()
        } else {
            "后台状态待确认".into()
        },
        queue: if fresh {
            format!("待上传音频：{} 段", report.pending_count)
        } else {
            "待上传音频：待确认".into()
        },
        pause: safe && recording,
        resume: safe && !recording && report.capture == "paused",
        finish: safe && (recording || report.capture == "paused"),
        settings: safe,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdatePresentation {
    pub status: String,
    pub check: bool,
    pub background: bool,
    pub auto_download: bool,
    pub install: bool,
}

pub fn present_update(
    phase: &str,
    configured: bool,
    operating: bool,
    fresh: bool,
    auto_download: bool,
    install_reason: Option<&str>,
) -> UpdatePresentation {
    let busy = operating || ["checking", "downloading", "preparing", "installing"].contains(&phase);
    let enabled = configured && phase != "disabled" && !busy && fresh;
    let reason = if !configured || phase == "disabled" {
        "未配置可信更新源，请手动安装新版"
    } else if !fresh {
        "页面状态待确认，请打开聆记"
    } else {
        match phase {
            "checking" => "正在检查更新…",
            "downloading" => "正在后台下载并验证签名…",
            "preparing" | "installing" => "正在准备或安装更新…",
            "ready" => install_reason.unwrap_or("更新已验签，可重启更新"),
            "available" => "发现新版本，可在设置中下载",
            "current" => "当前已是最新版本",
            "error" => "检查更新未完成，可重试",
            _ => "可检查新版本",
        }
    };
    UpdatePresentation {
        status: format!("更新：{reason}"),
        check: enabled,
        background: enabled,
        auto_download,
        install: enabled && phase == "ready" && install_reason.is_none(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_menu_requires_trust_verified_download_fresh_state_and_safe_recording() {
        let ready = present_update("ready", true, false, true, true, None);
        assert!(ready.check && ready.background && ready.auto_download && ready.install);
        for reason in [
            "正在录音",
            "本场处于暂停状态",
            "本机仍有待传音频",
            "正在保存音频",
        ] {
            let blocked = present_update("ready", true, false, true, false, Some(reason));
            assert!(!blocked.install);
            assert!(blocked.background && blocked.check && blocked.status.contains(reason));
        }
        for view in [
            present_update("disabled", false, false, true, false, None),
            present_update("ready", true, false, false, false, None),
            present_update("ready", true, true, true, false, None),
            present_update("downloading", true, false, true, true, None),
        ] {
            assert!(!view.check && !view.background && !view.install);
        }
        assert!(!present_update("available", true, false, true, false, None).install);
    }
    #[test]
    fn recording_pause_queue_and_stale_states_are_distinct() {
        let mut r = Report {
            authenticated: true,
            record_title: "演练\n会议".into(),
            capture: "recording".into(),
            connection: "connected".into(),
            ..Default::default()
        };
        let p = present(&r, true, true);
        assert!(p.pause && p.finish && !p.resume);
        assert_eq!(p.record, "会议：演练会议");
        r.capture = "paused".into();
        let p = present(&r, false, true);
        assert!(p.resume && p.finish && !p.pause);
        r.capture = "completed".into();
        r.pending_count = 4;
        assert_eq!(present(&r, false, true).title, "补传");
        let stale = present(&r, false, false);
        assert!(!stale.pause && !stale.resume && !stale.finish);
        assert!(stale.queue.contains("待确认"));
        r.busy = true;
        assert!(!present(&r, true, true).pause);
    }
    #[test]
    fn native_capture_is_authoritative_and_unsafe_labels_are_bounded() {
        let r = Report {
            authenticated: true,
            record_title: "长会议".repeat(100),
            ..Default::default()
        };
        assert!(present(&r, true, true).pause);
        assert!(present(&r, false, true).record.chars().count() <= 39);
        assert!(!present(&Report::default(), true, true).pause);
    }
}
