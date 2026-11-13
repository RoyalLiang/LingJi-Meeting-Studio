# 接入官网下载源

官网的“立即下载”进入系统选择区，识别 macOS、Windows 或 Linux；用户也可手动选择。macOS 包仅支持 Apple Silicon，Windows 与 Linux 包为 x64。手机不会被识别成可安装的桌面系统。

当前代码已实现系统 tab、下载目录和流式下载响应。用户已确认沿用阿里云 OSS；Bucket、地域、目录和访问方式尚待提供，公网下载尚未完成接入。未配置下载源或目录不完整时，页面显示暂不可下载。

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

完整文件先上传并核对大小及 SHA-256，再原子更新目录。版本路径不覆盖，失败保留上一个完整目录。OSS 上传权限与实际目录确认后再接入发布工作流。

## 沿用阿里云 OSS

只使用 OSS 时，可将安装包放在独立发布目录，例如 `lingji/releases/`，并以该目录的公开 HTTPS 地址配置 `DOWNLOADS_BASE_URL`。必须使用公网 Bucket 域名或已绑定的 HTTPS 自定义域名；Cloudflare 无法使用阿里云内网 Endpoint。Bucket 域名包含 Bucket 名称，不能仅填写地域 Endpoint。[OSS 访问域名](https://help.aliyun.com/zh/oss/user-guide/access-oss-via-bucket-domain-name)

若已有阿里云 CDN，可沿用下载域名，让 CDN 鉴权回源私有 OSS。相同账号优先使用 STS 回源方式，无需在官网保存 OSS 长期密钥。CDN 对外下载地址仍需可公开读取；如果另有 URL 鉴权，应单独接入，当前下载源配置不接受临时签名 URL。[私有 Bucket 回源](https://help.aliyun.com/zh/cdn/user-guide/grant-alibaba-cloud-cdn-access-permissions-on-private-oss-buckets)

发布目录只存公开安装包和 `current.json`。共享 Bucket 不应整体改成公共读；按发布对象或前缀授予读取权限，上传身份仅获得发布目录所需的写入权限。CDN 私有回源可能获得整个源 Bucket 的读取能力，也应避免与私人录音、分享文件混放。[OSS 权限控制](https://help.aliyun.com/zh/oss/user-guide/permissions-and-access-control-overview)

按以下顺序接入：

1. 确认 Bucket 名称、地域、目录前缀、下载域名及公共读或私有模式。使用自定义域名时，先完成 HTTPS 和域名绑定要求。
2. 从发布工作流上传同版三个最终安装包，核对文件大小和 SHA-256 后，最后更新 `current.json`。不要给安装包设置 gzip/br 等内容编码；目录短缓存，版本文件长缓存。
3. 将公开下载根目录写入 GitHub 仓库变量 `DOWNLOADS_BASE_URL`，通过现有官网工作流部署。若已有防盗链规则，需实际核验官网服务端回源；当前路由不会传递浏览器 Referer、Cookie 或 Authorization。
4. 在公网核对目录、HEAD、小范围下载、断点续传及下载文件名。OSS 支持 Range，但实际 CDN 与权限规则仍需一起核验。[GetObject](https://help.aliyun.com/zh/oss/developer-reference/getobject)

配置时只交换公开地址和权限模式。AccessKey、私钥或临时凭据通过受保护的部署配置注入，不放在 README、前端或聊天中。当前没有创建 Bucket、修改 ACL、上传安装包或配置云端凭据。

## 让浏览器下载文件

页面只读取同源 `/api/downloads`，不需要开放 CDN 的浏览器 CORS。安装包从官网 `/downloads/v版本/文件名` 读取既有 CDN，并以 `Content-Disposition: attachment` 流式返回；不跳转或回源 GitHub，也不把整个文件读入 Worker 内存。

下载源需直接返回文件，支持 GET、HEAD，并正确处理 Range、If-Range、ETag 和 Content-Length。下载路由传递这些请求/响应头；不跟随下载源的重定向，不转发用户 Cookie 或 Authorization。HTML 错误页不能作为安装包返回。

下载源是否支持断点续传、最终文件是否与清单一致，需要上线单独核验。SHA-256 不等于 Windows 发布者签名，签名状态另见[应用签名](application-signing.md)。

## 分开核对本地与公网

本地检查覆盖系统识别、键盘 tab、合成文件下载、范围/缓存响应和错误分支。接入实际 CDN 后，再核对完整目录、三个文件的 HEAD/小范围请求和浏览器下载。未经单独要求，不在开发机下载或安装完整发布包。
