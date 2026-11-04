use std::process::Command;

fn allowed(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "外部链接无效")?;
    if value.len() > 8192 || !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty() || url.password().is_some()
        || url.host_str().unwrap_or("").is_empty() || value.chars().any(|c| c.is_control()) {
        return Err("只允许打开不含登录凭据的 HTTP 或 HTTPS 链接".into());
    }
    Ok(url)
}

pub fn open(value: &str) -> Result<(), String> {
    let url = allowed(value)?;
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/open");
    #[cfg(target_os = "windows")]
    let mut command = { let mut value = Command::new("rundll32.exe"); value.arg("url.dll,FileProtocolHandler"); value };
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    command.arg(url.as_str()).spawn().map_err(|_| "无法打开系统浏览器，请复制链接到浏览器")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn integration_links_accept_web_results_and_reject_executable_or_credential_urls() {
        for value in ["https://team.feishu.cn/docx/token", "https://github.com/org/repo", "https://git.example.test/root/project/-/merge_requests/1", "https://git.example.test:8443/root/project/-/commit/abc", "http://git.local/project"] {
            assert!(allowed(value).is_ok(), "{value}");
        }
        for value in ["file:///tmp/code", "javascript:alert(1)", "data:text/html,test", "mailto:test@example.com", "https://x@feishu.cn/", "https://:secret@git.example.test/", "https://user@git.example.test/", "https://git.example.test/\n"] {
            assert!(allowed(value).is_err(), "{value}");
        }
    }
}
