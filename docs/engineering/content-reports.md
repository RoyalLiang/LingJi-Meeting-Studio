# 内容举报运维

官网的 `/content` 说明内容准则、举报入口和处理范围。分享页仅附带访问 token 的 SHA-256 引用编号，不发送原始 token、解密密钥、会议正文或音频。GitHub Issue 是公开渠道，举报表单提示用户不要提交隐私；收到敏感材料时应限制公开传播，按实际情况请求必要补充信息。

## 复核与停止分享

逐条复核内容举报及 Microsoft 发来的处理请求，记录事实、处理结论和时间。加密分享无法仅凭引用编号核实正文，不应把未经证实的指控视为事实。需要停止访问时，具备 D1 管理权限的维护者在正式分享数据库执行下列操作。

先验证引用编号恰为 64 位小写十六进制；它不能包含 SQL、网址或其他字符。将 `REFERENCE` 替换为核对后的编号，在 Cloudflare D1 控制台先查询匹配记录，确认后撤销：

```sql
SELECT id, created_at, expires_at, revoked_at FROM encrypted_shares WHERE token_hash='REFERENCE';
SELECT id, created_at, expires_at, revoked_at FROM shares WHERE token_hash='REFERENCE';
UPDATE encrypted_shares SET revoked_at=COALESCE(revoked_at,unixepoch()*1000),payload=NULL WHERE token_hash='REFERENCE';
UPDATE shares SET revoked_at=COALESCE(revoked_at,unixepoch()*1000),payload=NULL WHERE token_hash='REFERENCE';
```

不要按创建者、IP 或时间范围批量删除。撤销后，既有内容和状态接口应返回不可用；已打开页面会在状态检查时停止显示。操作记录只保留引用编号、结论和时间，不复制会议内容。已保存的副本无法收回。

## 验证边界

SQLite 回归覆盖两种分享路由按引用编号撤销后的读取与状态拒绝。测试不操作线上用户分享；正式投诉处理依赖维护者实际复核，尚未证明处理时效。该机制不提供用户封禁，也不替代模型服务的内容规则或商店年龄分级要求。
