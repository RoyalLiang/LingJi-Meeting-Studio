# 接入官网下载源

官网的“立即下载”进入系统选择区，识别 macOS、Windows 或 Linux；用户也可手动选择。macOS 包仅支持 Apple Silicon，Windows 与 Linux 包为 x64。手机不会被识别成可安装的桌面系统。

当前代码已实现系统 tab、下载目录和流式下载响应；实际存储/CDN 的地址与访问方式尚待提供，公网下载尚未完成接入。未配置下载源或目录不完整时，页面显示暂不可下载。

## 使用既有存储或 CDN

下载源通过 GitHub 仓库变量 `DOWNLOADS_BASE_URL` 配置为公开 HTTPS 目录，现有 **Cloudflare Pages beta** 发布流程会将其传给服务端。URL 不包含密码、查询凭据或临时签名；不接受 GitHub 下载源。私有存储或带签名的 CDN 应先确定访问方式，再接入后端凭据，不能把长期密钥放入 URL。

目录约定：

```text
current.json
v0.3.30/Lingji-0.3.30-macos-arm64.dmg
v0.3.30/Lingji-0.3.30-windows-x64-setup.exe
v0.3.30/Lingji-0.3.30-linux-amd64.deb
```

`current.json` 必须包含同一已发布版本的三个成品安装包。每项字段为 `name`、实际字节数 `size`、64 位十六进制 `sha256`；顶层字段为 `version` 和 `assets`。摘要取最终发布的文件，不能用源码或签名前产物的摘要替代。

完整文件先上传并核对大小及 SHA-256，再原子更新目录。版本路径不覆盖，失败保留上一个完整目录。具体上传命令和 CI 凭据待存储/CDN 提供方确定后配置，不预设新存储服务。

## 让浏览器下载文件

页面只读取同源 `/api/downloads`，不需要开放 CDN 的浏览器 CORS。安装包从官网 `/downloads/v版本/文件名` 读取既有 CDN，并以 `Content-Disposition: attachment` 流式返回；不跳转或回源 GitHub，也不把整个文件读入 Worker 内存。

下载源需直接返回文件，支持 GET、HEAD，并正确处理 Range、If-Range、ETag 和 Content-Length。下载路由传递这些请求/响应头；不跟随下载源的重定向，不转发用户 Cookie 或 Authorization。HTML 错误页不能作为安装包返回。

下载源是否支持断点续传、最终文件是否与清单一致，需要上线单独核验。SHA-256 不等于 Windows 发布者签名，签名状态另见[应用签名](application-signing.md)。

## 分开核对本地与公网

本地检查覆盖系统识别、键盘 tab、合成文件下载、范围/缓存响应和错误分支。接入实际 CDN 后，再核对完整目录、三个文件的 HEAD/小范围请求和浏览器下载。未经单独要求，不在开发机下载或安装完整发布包。
