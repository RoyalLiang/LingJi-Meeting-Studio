# 接入官网下载源

官网的“立即下载”进入系统选择区，识别 macOS、Windows 或 Linux；用户也可手动选择。macOS 包仅支持 Apple Silicon，Windows 与 Linux 包为 x64。手机不会被识别成可安装的桌面系统。

当前代码已实现系统 tab、下载目录和流式下载响应。下载源为阿里云 OSS `lingji-studio`，地域 `cn-shanghai`，发布目录 `releases/`。上传授权和公网验收尚未完成；目录不完整时，页面显示暂不可下载。

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

完整文件先上传并核对大小及 SHA-256，再更新目录。版本路径不覆盖，失败保留上一个完整目录。`Publish OSS website downloads` 工作流在桌面预览版发布成功后执行，也可在 main 手动指定已发布标签；它在隔离 runner 中转存附件，浏览器不会访问 GitHub 安装包地址。

当前下载根目录：

```text
https://lingji-studio.oss-cn-shanghai.aliyuncs.com/releases/
```

## 沿用阿里云 OSS

只使用 OSS 时，可将安装包放在独立发布目录，例如 `lingji/releases/`，并以该目录的公开 HTTPS 地址配置 `DOWNLOADS_BASE_URL`。必须使用公网 Bucket 域名或已绑定的 HTTPS 自定义域名；Cloudflare 无法使用阿里云内网 Endpoint。Bucket 域名包含 Bucket 名称，不能仅填写地域 Endpoint。[OSS 访问域名](https://help.aliyun.com/zh/oss/user-guide/access-oss-via-bucket-domain-name)

若已有阿里云 CDN，可沿用下载域名，让 CDN 鉴权回源私有 OSS。相同账号优先使用 STS 回源方式，无需在官网保存 OSS 长期密钥。CDN 对外下载地址仍需可公开读取；如果另有 URL 鉴权，应单独接入，当前下载源配置不接受临时签名 URL。[私有 Bucket 回源](https://help.aliyun.com/zh/cdn/user-guide/grant-alibaba-cloud-cdn-access-permissions-on-private-oss-buckets)

发布目录只存公开安装包和 `current.json`。共享 Bucket 不应整体改成公共读；按发布对象或前缀授予读取权限，上传身份仅获得发布目录所需的写入权限。CDN 私有回源可能获得整个源 Bucket 的读取能力，也应避免与私人录音、分享文件混放。[OSS 权限控制](https://help.aliyun.com/zh/oss/user-guide/permissions-and-access-control-overview)

按以下顺序接入：

1. 确认 Bucket 名称、地域、目录前缀、下载域名及公共读或私有模式。使用自定义域名时，先完成 HTTPS 和域名绑定要求。
2. 从发布工作流上传同版三个最终安装包，核对文件大小和 SHA-256 后，最后更新 `current.json`。不要给安装包设置 gzip/br 等内容编码；目录短缓存，版本文件长缓存。
3. 将公开下载根目录写入 GitHub 仓库变量 `DOWNLOADS_BASE_URL`，通过现有官网工作流部署。若已有防盗链规则，需实际核验官网服务端回源；当前路由不会传递浏览器 Referer、Cookie 或 Authorization。
4. 在公网核对目录、HEAD、小范围下载、断点续传及下载文件名。OSS 支持 Range，但实际 CDN 与权限规则仍需一起核验。[GetObject](https://help.aliyun.com/zh/oss/developer-reference/getobject)

配置时只交换公开地址和权限模式。AccessKey、私钥或临时凭据通过受保护的部署配置注入，不放在 README、前端或聊天中。当前没有新建 Bucket 或修改 Bucket ACL。

## 为发布工作流配置短期授权

GitHub 仓库变量 `DOWNLOADS_BASE_URL` 使用上述下载根目录。OSS 上传使用 GitHub OIDC 换取 STS 临时凭据，不保存长期 AccessKey。阿里云官方认证 Action 固定到完整提交 SHA，随后由锁定版本的官方 `ali-oss` SDK 使用 V4 签名上传。[官方 OIDC Action](https://github.com/aliyun/configure-aliyun-credentials-action)

首次运行上传工作流会输出 `website-download-identity` 回执，仅包含公开的 issuer、audience、subject、仓库和分支，不输出原始 JWT。尚未配置角色时，作业只核对身份并明确报告“未上传”。按实际 subject 配置 RAM，不能猜测旧格式；GitHub 的新仓库可能使用包含不可变 ID 的 subject。[GitHub OIDC 格式](https://docs.github.com/en/actions/reference/security/oidc)

申请创建或复用专用的 OIDC Provider 和 RAM 角色前，先核对这些值：

- issuer：`https://token.actions.githubusercontent.com`。
- audience：`sts.aliyuncs.com`。
- subject：身份回执中的精确值，仅允许本仓库 main；不使用仓库或组织通配符。
- 上传权限：[目录权限草稿](oss-download-upload-policy.json)，仅允许 `lingji-studio/releases/*` 的读取、写入与对象 ACL，以及该 Bucket 版本状态的只读查询；没有列举、删除或 Bucket 管理权限。

将公开的角色 ARN 和 Provider ARN 分别配置为 GitHub 仓库变量 `OSS_UPLOAD_ROLE_ARN`、`OSS_OIDC_PROVIDER_ARN`。RAM 信任动作使用 `sts:AssumeRole`，条件同时限定 `oidc:iss`、`oidc:aud`、`oidc:sub`。IAM 资源与授权变更单独确认后执行。[可信 IdP 角色](https://www.alibabacloud.com/help/en/ram/user-guide/create-a-ram-role-for-a-trusted-idp)

版本文件以单个流式 PUT 上传，服务端校验 Content-MD5，发布作业校验实际文件 SHA-256 与 Release digest。上传后核对大小、SHA-256 元数据、单次 PUT 的 ETag、对象公共读及匿名 HEAD；清单写入后再从 OSS 和公开地址读回。ETag 不代替 SHA-256。版本控制启用或暂停时，OSS 的禁止覆盖头无效，作业会拒绝上传，不自动改变 Bucket 版本状态。[PutObject 限制](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject)

OSS 不支持 PutObject 的 If-Match 条件写。`releases/` 必须由该工作流单独维护；所有版本共用串行并发组，清单写入前检查版本号，禁止旧作业回退新版本。若增加其他发布者，应先加入共享锁等协调机制，不能直接并行写 `current.json`。[条件写限制](https://www.alibabacloud.com/help/en/oss/user-guide/0017-00000245)

## 让浏览器下载文件

页面只读取同源 `/api/downloads`，不需要开放 CDN 的浏览器 CORS。安装包从官网 `/downloads/v版本/文件名` 读取既有 CDN，并以 `Content-Disposition: attachment` 流式返回；不跳转或回源 GitHub，也不把整个文件读入 Worker 内存。

下载源需直接返回文件，支持 GET、HEAD，并正确处理 Range、If-Range、ETag 和 Content-Length。下载路由传递这些请求/响应头；不跟随下载源的重定向，不转发用户 Cookie 或 Authorization。HTML 错误页不能作为安装包返回。

下载源是否支持断点续传、最终文件是否与清单一致，需要上线单独核验。SHA-256 不等于 Windows 发布者签名，签名状态另见[应用签名](application-signing.md)。

## 分开核对本地与公网

本地检查覆盖系统识别、键盘 tab、合成文件下载、范围/缓存响应和错误分支。接入实际 CDN 后，再核对完整目录、三个文件的 HEAD/小范围请求和浏览器下载。未经单独要求，不在开发机下载或安装完整发布包。
