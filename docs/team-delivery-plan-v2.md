> 历史文档（2026-10-11 整理）：首版方向已改为浏览器优先、尽量免安装。本文保留原有设计背景，不作为当前实现或排期承诺；先读 [新文档入口](README.md) 与 [当前状态](engineering/current-state.md)。

# 团队推进文档 v2

- 文档状态：`Draft`
- 更新时间：`2026-03-19`

## 1. 团队使命

围绕“实时语言工作台”这一主产品方向，在 6-8 人开发专家团队阵型下，用清晰 ownership 和小步交付，把实时传译、总结、文件夹、导出与悬浮窗打磨成可试点产品。

## 2. 本阶段上下文假设

- 一个主产品
- 一个主代码库
- 中等可靠性要求
- 多 provider 语音 / 翻译能力属于核心能力
- 用户对实时体验、导出质量和知识沉淀同样敏感

## 3. 推荐阵型与直接 Owner

### 产品负责人 Product Owner

- 直接 owner：需求排序、场景边界、验收标准
- 当前最重要的问题：首发版本究竟优先“跨语言会议”，还是“培训 / 讲座字幕”

### 技术负责人 Tech Lead

- 直接 owner：产品边界到系统边界的翻译
- 当前最重要的问题：provider 抽象如何兼容 ASR 与同传模型，而不把系统写死

### 后端专家 Backend Expert

- 直接 owner：实时链路、provider adapter、导出任务、文件夹元数据
- 当前最重要的问题：会话、文件夹、summary、export 的数据契约怎么对齐

### 前端专家 Frontend Expert

- 直接 owner：桌面主界面、悬浮窗、原文译文双栏、回放与文件夹 UI
- 当前最重要的问题：用户在会议中应该看什么、会后应该看什么

### 测试自动化负责人 QA Automation Lead

- 直接 owner：实时回归、导出回归、provider fallback 回归
- 当前最重要的问题：如何把实时风险转成稳定可重复的 smoke gate

### DevOps / SRE

- 直接 owner：本地环境、provider 配置、日志、可观测性、导出任务运行环境
- 当前最重要的问题：本地 / 试点环境如何最小成本稳定运行

### 安全与隐私顾问 Security / Privacy Advisor

- 直接 owner：录音保留、分享边界、文件夹权限、导出文件安全
- 当前最重要的问题：录音和 PDF 是否默认可分享，保留策略如何定义

### 数据与 AI 顾问 Data / AI Advisor

- 直接 owner：转录质量评估、翻译质量评估、summary 质量标准
- 当前最重要的问题：如何衡量渐进式总结是“有用”而不是“看起来聪明”

## 4. 全局规则

- 同一阶段只允许一条主线
- 每个关键结果只有一个直接 owner
- 范围必须显式裁剪
- 实时风险优先于花哨功能
- AI 产出如果没有评估，不允许对外承诺质量

## 5. 当前推荐主线

### 主线名称

`双语实时工作台最小闭环`

### 为什么是它

因为它同时验证了产品三件最关键的事：

1. 用户愿不愿意在会中持续看原文 + 译文
2. 渐进式总结是否真能减轻信息负担
3. 会后沉淀（文件夹 / PDF）是否形成复用价值

## 6. 下一轮交付顺序

### 第 1 顺位：桌面主路径

- owner：Frontend Expert
- 交付：
  - 双栏 transcript
  - 渐进式总结区
  - 悬浮窗模式切换

### 第 2 顺位：文件夹系统

- owner：Backend Expert
- 协同：Product Owner
- 交付：
  - folder 数据模型
  - session 归档到 folder
  - folder 级默认语言与术语配置

### 第 3 顺位：导出系统

- owner：Backend Expert
- 协同：Frontend Expert、Security / Privacy Advisor
- 交付：
  - 录音导出
  - summary PDF 生成
  - 导出入口与状态展示

### 第 4 顺位：质量与观测

- owner：QA Automation Lead
- 协同：DevOps / SRE
- 交付：
  - export smoke tests
  - folder flow smoke tests
  - provider / summary 指标面板

## 7. 角色协作契约

### Product Owner 与 Tech Lead

- 产品负责人定义“用户到底要完成什么”
- 技术负责人定义“系统怎样最简单地支撑它”

### Backend Expert 与 Frontend Expert

- 后端专家保证 transcript / translation / summary / folder 契约稳定
- 前端专家保证这些契约能被用户低摩擦消费，而不是堆字段

### QA 与 DevOps / SRE

- QA 定义风险层级
- DevOps / SRE 确保这些风险能被看见、能回放、能恢复

## 8. 阶段性成功信号

- 双栏 transcript 被持续使用，而不是用户只盯一栏
- summary 面板被用户保留开启
- folder 被真实用于归档，而不是摆设
- PDF 导出成功率高且有人复用
- 悬浮窗在真实会中被长期打开

## 9. 危险气味

- 同时做太多 UI 形态导致主路径不清
- 文件夹只是一个“名字容器”，没有默认配置与知识价值
- PDF 导出只是截图，不具备结构化价值
- 总结更新过快造成认知噪音
- 原文 / 译文错位，反而增加阅读负担

## 10. 下一轮具体 TODO

1. Product Owner：拍板“当前语种默认不转译”的交互规则
2. Tech Lead：定义 transcript / translation / summary / folder 的统一会话视图模型
3. Backend Expert：补 folder 与 export 数据模型初稿
4. Frontend Expert：给桌面壳增加双栏 transcript 和 summary 区
5. QA Automation Lead：新增 folder/export smoke tests 草案

## 11. 本文档与现有文档关系

- `docs/prd-v1.md`：原始 0 -> 1 版本边界
- `docs/prd-expansion-v2.md`：本次扩展后的产品蓝图
- `docs/team-operating-model-v1.md`：基础团队运行规则
- `docs/team-delivery-plan-v2.md`：本次扩展阶段的具体推进顺序
