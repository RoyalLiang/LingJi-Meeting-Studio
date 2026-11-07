# 旧飞书 HTTPS 回调已移除

2026-11-01，用户明确要求完全移除用户授权与公网回调，统一使用官方 SDK 长连接和应用身份。当前配置无需 `auth.rookiecode.com`、重定向 URL 或用户授权。

请按[飞书 SDK 配置](feishu-sdk.md)操作。此前方案仅保留为 ADR 0024 的历史记录，由 ADR 0025 取代。

[退役作业](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41310040992)已成功：原 Pages 回调、事务和配置入口返回 410，3 个历史部署已清除。原自定义域名未解析，不再需要配置。D1 保留为闲置历史资源；其内容未读取，其他 DNS 和服务未修改。见回执。
