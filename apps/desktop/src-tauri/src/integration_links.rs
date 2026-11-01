use std::process::Command;

fn allowed(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "外部链接无效")?;
    let host = url.host_str().unwrap_or("");
    if value.len() > 8192 || url.scheme() != "https" || !url.username().is_empty()
        || url.password().is_some() || url.port().is_some()
        || !(host == "feishu.cn" || host.ends_with(".feishu.cn") || host == "github.com")
    { return Err("只允许打开飞书或 GitHub 的 HTTPS 链接".into()); }
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
    fn integration_links_allow_only_expected_https_hosts() {
        for value in ["https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=a&code_challenge=b", "https://team.feishu.cn/docx/token", "https://github.com/org/repo"] { assert!(allowed(value).is_ok()); }
        for value in ["file:///tmp/code", "https://evil.test/", "https://feishu.cn.evil.test/", "https://evilfeishu.cn/", "https://x@feishu.cn/", "http://feishu.cn/", "https://feishu.cn:444/"] { assert!(allowed(value).is_err()); }
    }
}
