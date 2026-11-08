# Record 音频传输与增量更新

## 音频能力由 API 明确协商

Bootstrap 返回 `audioTransport: "pcm-v1"` 时，客户端向 `/api/records/:id/audio` 发送 `application/octet-stream` PCM，并将身份和时序元数据放入 `X-Record-Audio` JSON 头。不支持该能力的服务继续收到 Base64 JSON。两种传输保留同源 Cookie、CSRF 和相同的身份校验。

`record/session/source/epoch/sequence`、采样偏移、SHA-256、持久化 ACK、冲突检测、重传去重与停止排空语义相同。ACK 表示字节已持久化，不代表 ASR 或纪要已完成。

单包最多 480,000 字节，元数据头最多 2,048 字节。服务端拒绝错误摘要、身份或采样区间；重复请求不重复记账。

## 队列保存二进制并兼容旧数据

新 IndexedDB 分片直接保存 PCM 字节，旧 Base64 分片继续可补传。旧 API 和人工下载的 `meeting-audio-backup/v1` 故障备份仍使用 Base64。队列按来源排序上传，失败来源不阻塞其他来源。

桌面本机优先取得 Record API 持久化回执，再保存本机停止游标并 ACK Rust；2 秒内未完成或请求失败时退回 IndexedDB。完整数据与停止游标确认之前，不删除 Rust 的持久化队首。

## SSE 保留游标、鉴权与跨进程检查

服务端从独立事件投影发送增量。客户端只在 `baseCursor` 匹配时应用 delta；游标不连续时重新读取完整快照。

同一进程的仓库变更唤醒 SSE，独立进程之间保留每秒检查。连接持续重验权限，退出登录或失去记录访问权后关闭。客户端背压、心跳与断线补历史继续生效；当前尚未接入 PG LISTEN/NOTIFY。

SQLite 集合格式、迁移备份与音频导入限制见[存储与性能边界](storage-and-performance.md)。本地合成回归不能替代真实网络、长录音、PG/S3 或供应商首字验收。
