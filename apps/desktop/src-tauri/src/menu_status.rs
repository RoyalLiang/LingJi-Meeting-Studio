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

#[cfg(test)]
mod tests {
    use super::*;
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
