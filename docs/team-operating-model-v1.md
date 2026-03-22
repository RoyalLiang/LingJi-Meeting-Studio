# 团队运行模型 v1

- 状态：`Draft`
- 更新时间：`2026-03-19`

## 团队使命

在不牺牲可靠性、隐私和工程清晰度的前提下，把 `TTS Platform` 从 prototype 推进到可试点的实时语音协作产品。

## 当前阶段

- 产品阶段：`0 -> 1`
- 主代码库：一个
- 当前主线：一条
- 发布目标：每周可回归、每两周可演示
- 可靠性要求：中等，但实时链路必须可观察

## 推荐阵型

### 产品负责人 Product Owner

- 直接 owner：首发场景、范围边界、试点用户反馈
- 当前必须回答的问题：我们先打透“麦克风实时转录”，还是“会议软件系统音频采集”？

### 技术负责人 Tech Lead

- 直接 owner：架构边界、接口契约、技术风险取舍
- 当前必须回答的问题：真实采集先走 Electron 原生能力，还是先用浏览器/Node 混合临时方案？

### 后端专家 Backend Expert

- 直接 owner：`session-gateway`、`transcript-api`、持久化契约
- 当前冲刺目标：把 `audio-chunks` 从 mock transcript hint 升级到真实音频帧协议

### 前端专家 Frontend Expert

- 直接 owner：`apps/web` 和未来桌面 UI 主路径
- 当前冲刺目标：给 Web 原型增加 session 列表、健康状态、回放可视化和调试面板

### 测试自动化负责人 QA Automation Lead

- 直接 owner：smoke tests、回归门禁、测试数据
- 当前冲刺目标：把 memory/postgres/audio chunk 三类 smoke tests 固化进每轮回归

### DevOps / SRE

- 直接 owner：本地环境、Docker、数据库运行手册、可观测性
- 当前冲刺目标：统一 `docker compose`、环境变量和启动顺序

### 安全与隐私顾问 Security / Privacy Advisor

- 直接 owner：录音告知、分享链接边界、音频保留策略
- 当前冲刺目标：定义默认“不存原始音频”的安全基线

### 数据与 AI 顾问 Data / AI Advisor

- 直接 owner：ASR 评测集、翻译质量、AI 纪要评估
- 当前冲刺目标：建立 20-50 条内部基准样本，别让“看起来能用”替代评估

## 全局规则

- 每个阶段只有一条主线，不同时推进多个高耦合方向
- 每个关键结果只有一个直接 owner
- 先做可复现测试，再做复杂功能扩展
- 先把真实输入接进来，再优化 AI 输出

## 下一轮唯一主线

把“浏览器/调试台级采集 prototype”推进到“正式桌面壳 + 真实 ASR 接入前的稳定采集面”。

### 结果 owner

- 技术负责人：拍板采集架构
- 后端专家：定义 chunk 协议与接收约束
- 前端专家：桌面端交互与状态展示
- QA 自动化负责人：补设备采集 smoke test

## 下一轮切分

1. 把当前浏览器麦克风采集经验沉淀成正式桌面端状态机
2. 选择并接入一个真实流式 ASR provider adapter
3. 把 `audio-chunks` 从 debug 接口升级成稳定采集协议
4. 建立最小可观测性：chunk 错误率、session 启动率、partial/final 延迟
5. 增加“桌面采集 -> ASR -> replay”的自动化回归

## 为什么前面看起来不像“专家团队”

因为前几轮主要在搭底座，我是按单线程 ownership 把主链路先打通了，还没有把角色章程和回归制度显式写进仓库。现在这份文档和测试脚手架就是把“个人推进”切换成“团队系统推进”的第一步。

## 当前已完成里程碑

- transcript-api 已支持 memory / postgres 双后端
- session-gateway 已支持文本 ingest 和二进制 audio chunk
- 浏览器调试台已支持设备枚举、麦克风采集和 chunk 发送
- smoke tests 已覆盖 memory / postgres / invalid chunk 三类主路径
