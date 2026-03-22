# Transcript API

负责业务 API、持久化、权限、工作区和回放查询。

## 责任边界

- session 元数据
- segments 与 translations 持久化
- share links
- glossary 与参考资料
- 历史查询与 viewer bootstrap

## 首批实现顺序

1. session CRUD
2. segment 写接口
3. replay 读接口
4. share link bootstrap
5. glossary 管理

## 当前实现状态

- 已支持 `memory` 存储模式，适合本地原型和快速回归
- 已支持 `postgres` 存储模式，适合真实持久化验证
- 已提供 schema 迁移入口：`node ./src/migrate.mjs`

## 关键环境变量

- `TRANSCRIPT_API_STORAGE=memory|postgres`
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tts`
- `TRANSCRIPT_API_AUTO_MIGRATE=true|false`
