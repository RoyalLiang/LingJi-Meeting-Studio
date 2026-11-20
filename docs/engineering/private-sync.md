# 加密同步测试环境

此流程供 0.4 开发分支的邀请制测试使用。从桌面侧栏底部的「账号」注册或登录，可在「会议同步」发送已完成会议的转录、纪要和手记，也可以把收到的版本恢复到本机。侧栏显示当前登录邮箱，退出后恢复「未登录」。账号同步按明确选择的会议执行。原音、截图、连接器密钥和声纹数据留在设备上。

## 启动独立的 HTTPS 实例

测试域使用 `https://lingji.rookiehouse.com`。DNS 指向独立同步 API 的 HTTPS 入口。反向代理只把这个域路由到独立 Web 服务，保留原始 `Host`。云端使用单独的 PostgreSQL 和记录目录，使用运行环境的 secret 注入方式配置数据库地址、会话密钥和注册邀请码。

```sh
export NODE_ENV=production
export RECORD_SYNC_ORIGIN=https://lingji.rookiehouse.com
export RECORD_DATA_DIR=/path/to/isolated/sync-data
export RECORD_API_PORT=3030
export WEB_PORT=3000
export RECORD_API_URL=http://127.0.0.1:3030
npm run build:web
```

用独立进程分别运行 `npm run dev:records` 和 `node apps/web/src/production-server.mjs`。两个端口均监听本机，HTTPS 代理转发至 3000。同步服务不需要启用录音或转录 worker。生产模式启动时要求 `RECORD_DATABASE_URL`、`RECORD_SESSION_SECRET` 和至少 16 字符的 `RECORD_INVITE_CODE`。

## 在两台设备间验证

1. 在桌面「账号」中注册或登录。选择「设置同步」，下载 Recovery Kit 并保存到设备之外，再启用同步。
2. 在测试域的浏览器添加通行密钥，锁定资料库，再用同一个通行密钥解锁。服务端验证 WebAuthn 的来源、RP ID、一次性挑战和用户验证。浏览器用 PRF 派生密钥，上传的数据只有包装后的密钥及公开凭据材料。注册后若凭据不支持 PRF，可以从恢复密钥或其他设备配对解锁。[WebAuthn PRF](https://www.w3.org/TR/webauthn-3/#prf-extension)
3. 打开 macOS 桌面工作台，登录同一账号并同步一条合成会议。在「设备与通行密钥」中选择「配对新设备」。在 Windows 登录同一账号，展开「从旧设备配对」，读取二维码图片或输入配对码，再回到 macOS 确认访问。密钥用 OPAQUE 导出的会话材料包裹，中继按账号保存临时密文及握手帧。[OPAQUE RFC](https://www.rfc-editor.org/rfc/rfc9807.html)
4. 在 Windows 恢复该会议，核对转录、纪要引用和手记。用一个没有该本机数据目录或通行密钥的干净设备再验证 Recovery Kit，并确认用错密钥时会拒绝。

## 开发分支范围

客户端把选中的会议修订加密后存到本机待传队列，网络中断后可重试。服务端在同一账户的行锁内分配序号，按记录个数和字节限制分页。接收设备验证密文后，在一个本机事务中保存操作并推进游标。对同一会议各自编辑形成的并行修订可分别恢复。

当前同步保存逐次快照和分支修订，资料上传及恢复由用户显式触发。连续后台同步、设备单独撤销及换钥、云端删除与历史压缩、加密原音仍待完成。客户端对未知或错位的密文、越权请求和失效配对会拒绝处理。
