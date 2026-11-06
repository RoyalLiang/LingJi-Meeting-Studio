# Complete DSL & 12-Card Schema Reference

This reference documents the full JSON DSL schema, shorthand aliases (designed for minimum LLM output tokens), 12 color palettes, and 12 structured visual card types supported by `scripts/compile_minutes.py`.

---

## 1. Root Document Schema

| Key | Alias | Type | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `title` | `t` | `string` | Required | Main meeting title (displayed at top header) |
| `subtitle` | `sub` | `string` | `""` | Metadata line: Date, time, attendees, host, duration |
| `theme` | - | `string` | `"feishu-light"` | Global preset: `feishu-dark` \| `feishu-light` \| `ocean-glass` \| `minimal-ink` |
| `summary` | `sum` | `string` | `""` | Optional 1-sentence executive TL;DR banner |
| `tabs` | - | `string[]` | `["全部"]` | Filter tab labels shown below header. Section `tab` values bind to these |
| `sections` | `sec` | `object[]` | Required | Array of topic sections |

---

## 2. Section Schema (`sections[]`)

| Key | Alias | Type | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `title` | `t` | `string` | Required | Section heading text |
| `color` | `c` | `string` | `"blue"` | One of 12 semantic colors: `blue`, `amber`, `green`, `rose`, `cyan`, `indigo`, `purple`, `emerald`, `coral`, `slate`, `gold`, `crimson` |
| `icon` | `ic` | `string` | `"layers"` | Semantic icon key from the built-in 40+ SVG icon registry |
| `tab` | - | `string` | `""` | Category tab name for top-bar filtering |
| `tag` | - | `string` | `""` | Optional right-hand badge on section header (e.g. `"P0 核心"`, `"已对齐"`) |
| `collapsed` | - | `bool` | `false` | Whether the section starts collapsed |
| `items` | `b` | `array` | Required | Mixed array of **Strings** (rendered as tinted callout blocks) and **Card Objects** (`{"type": ...}`) |

> **Token-Saving Shorthand**: Any plain string inside `items` is automatically rendered as a `-` bullet inside a full-width tinted highlight block matching the section's `color`. You can also pass `{"text": "...", "tag": "@Owner", "icon": "pin"}` for an annotated callout block.

---

## 3. All 12 Structured Card Schemas

### Card 1: `flow` (Horizontal Process / Pipeline Card)
Replicates the horizontal stage progression card in Section 1 of the Feishu screenshot.
```json
{
  "type": "flow",
  "title": "业务推进四阶段链路",
  "steps": [
    {"t": "需求冻结與评审", "d": "完成 PRD 与接口契约对齐", "s": "done", "meta": "W1"},
    {"t": "核心链路灰度验证", "d": "重点监控转化率与异常熔断", "s": "active", "meta": "W2-W3 ★当前"},
    {"t": "全量切流与压测", "d": "承载 100% 生产峰值流量", "s": "pending", "meta": "W4"},
    {"t": "长效复盘与SOP沉淀", "d": "输出自动化监控看板", "s": "pending", "meta": "W5"}
  ],
  "progress": 45
}
```
- `s` (status): `"done"` (subtle green/check), `"active"` (highlighted amber/brown border & glow just like the screenshot), `"pending"` (muted dark box).

### Card 2: `branch` (Branching Topology / Architecture Flow Card)
Replicates the branching flow card in Section 4 of the Feishu screenshot (`Input -> Hub -> Parallel Branches`).
```json
{
  "type": "branch",
  "title": "流量分发与智能路由架构",
  "root": "全渠道请求接入",
  "hub": "智能策略路由网关",
  "branches": [
    [
      {"t": "高价值人群包", "s": "active"},
      {"t": "专属精排引擎 V2", "s": "done"}
    ],
    [
      {"t": "常规长尾流量", "s": "pending"},
      {"t": "轻量化缓存兜底策略", "s": "pending"}
    ]
  ]
}
```

### Card 3: `kpi` (Core Metric Delta / Comparison Card)
Replicates the `47.5% -> 79.6%` big-number metric card in Section 4 of the Feishu screenshot, extensible to multiple metric groups.
```json
{
  "type": "kpi",
  "title": "核心转化效率优化对比",
  "metrics": [
    {
      "label": "核心链路转化率",
      "fromLabel": "优化前基线",
      "from": "47.5%",
      "toLabel": "灰度实测值",
      "to": "79.6%",
      "delta": "+32.1%",
      "trend": "up"
    }
  ]
}
```
- `trend`: `"up"` (emerald highlight), `"down"` (rose highlight), `"neutral"` (blue/slate).
- If `from` is omitted, renders as a standalone hero KPI card (`label` + `to` + `delta`).

### Card 4: `grid` (Multi-Column Feature / Pillar Card)
Replicates the 3-column vertical-divider card in Section 7 of the Feishu screenshot.
```json
{
  "type": "grid",
  "title": "三大核心治理抓手",
  "cols": 3,
  "items": [
    {"t": "标准先行", "c": "cyan", "d": "统一跨端埋点字典与上报规范，消除口径歧义"},
    {"t": "灰度兜底", "c": "amber", "d": "全链路配置秒级回滚开关，异常 30s 内熔断"},
    {"t": "看板透明", "c": "green", "d": "核心指标 T+0 实时投屏，红绿灯责任到人"}
  ]
}
```

### Card 5: `table` (Structured Data / Comparison Table Card)
Replicates the dark-header structured tables across Sections 4, 6, 7, 9, and 10 of the screenshot.
```json
{
  "type": "table",
  "title": "核心模块排期与资源分配明细",
  "headers": ["序号", "模块名称", "核心交付内容", "负责人", "优先级"],
  "rows": [
    ["1", "智能路由网关", "支持动态权重与秒级降级", "@张伟", "P0"],
    ["2", "实时特征中心", "特征读取耗时降至 8ms 以内", "@李娜", "P0"],
    ["3", "自助分析看板", "支持多维下钻与异常告警", "@王强", "P1"]
  ]
}
```
- **Auto-Badge Styling**: Cells containing `P0`, `P1`, `P2`, `已完成`, `进行中`, `阻塞`, `高`, `中`, `低` are automatically styled with semantic pill badges or status accents.

### Card 6: `status-table` (RAG Status Lamp & Auto-Rowspan Table Card)
Replicates the grouped status indicator table in Section 10 of the screenshot (where identical first-column categories automatically merge vertically and the status column renders glowing 🟢/🟡/🔴 lamps).
```json
{
  "type": "status-table",
  "title": "多端专项验收与健康度追踪",
  "headers": ["业务域", "子模块", "验收状态", "核心进展与卡点说明"],
  "rows": [
    ["客户端域", "iOS 核心包", "🟢 正常", "已完成全量回归测试，Crash 率 < 0.01%"],
    ["客户端域", "Android 端", "🔴 阻塞", "低端机型内存峰值超标，需周三前完成纹理压缩"],
    ["服务端域", "推荐引擎", "🟢 正常", "压测 QPS 达 12,000，满足双十一峰值要求"],
    ["服务端域", "计费网关", "🟡 关注", "三方支付回调偶发延迟，正在联调重试机制"]
  ]
}
```

### Card 7: `timeline` (Vertical Milestone & Horizontal Roadmap Timeline Card)
Rich timeline component supporting both `"vertical"` and `"horizontal"` layouts.
```json
{
  "type": "timeline",
  "title": "Q4 关键里程碑推进时间轴",
  "mode": "horizontal",
  "events": [
    {"time": "11-05", "t": "方案评审冻结", "owner": "@全体", "s": "done", "d": "完成架构与排期签字"},
    {"time": "11-12", "t": "联调提测准入", "owner": "@研发组", "s": "active", "d": "核心接口 100% 跑通"},
    {"time": "11-18", "t": "10% 灰度放量", "owner": "@增长组", "s": "todo", "d": "观察 48h 留存与转化"},
    {"time": "11-25", "t": "全量正式发布", "owner": "@PMO", "s": "todo", "d": "召开阶段复盘会"}
  ]
}
```

### Card 8: `pros-cons` (Solution Trade-off & Decision Card)
```json
{
  "type": "pros-cons",
  "title": "存储引擎选型博弈与最终决议",
  "left": {
    "t": "方案 A：自研分布式缓存升级",
    "tag": "推荐采纳 ✓",
    "c": "green",
    "items": ["延迟降低 45%，无外部采购成本", "团队掌控度高，支持定制分片策略"]
  },
  "right": {
    "t": "方案 B：直接采购商业版云集群",
    "tag": "备选方案",
    "c": "amber",
    "items": ["上线周期短（仅需 3 天）", "年化成本超预算 68 万，存在厂商绑定风险"]
  },
  "verdict": "最终拍板：主链路采用「方案 A」，边缘非核心业务保留轻量云缓存过渡。"
}
```

### Card 9: `action-list` (Action Items & Deliverable Tracker Card)
```json
{
  "type": "action-list",
  "title": "会后必达 Action 清单",
  "actions": [
    {"t": "输出 Android 端内存优化专项方案并完成复测", "owner": "@陈杰", "p": "P0", "due": "11-07 18:00", "s": "todo"},
    {"t": "对齐财务与法务完成 Q4 渠道合同用印", "owner": "@林薇", "p": "P1", "due": "11-09 12:00", "s": "active"},
    {"t": "冻结 V2.4 埋点字典并同步至数据仓库团队", "owner": "@张伟", "p": "P0", "due": "11-05 当日", "s": "done"}
  ]
}
```

### Card 10: `quote-decision` (Executive Ruling / Key Consensus Banner)
```json
{
  "type": "quote-decision",
  "speaker": "技术委员会决议",
  "role": "架构红线原则",
  "text": "任何未经灰度开关包裹的核心链路变更，一律不得在周四及周五窗口期合入生产主干。",
  "impact": "适用范围：交易、推荐、账户三大核心域 | 生效时间：即刻执行"
}
```

### Card 11: `risk-matrix` (Risk & Mitigation Matrix Card)
```json
{
  "type": "risk-matrix",
  "title": "关键风险识别与应急预案",
  "risks": [
    {"risk": "大促峰值期间上游特征服务超时", "level": "high", "mitigation": "启用本地毫秒级热门兜底缓存，自动降级非核心特征", "owner": "@李娜"},
    {"risk": "外包美术资源交付延期 2 天", "level": "med", "mitigation": "提前准备模板化动态组件作为备选素材", "owner": "@周敏"}
  ]
}
```

### Card 12: `funnel-metric` (Conversion Funnel / Share Bar Card)
```json
{
  "type": "funnel-metric",
  "title": "用户激活全链路转化漏斗分析",
  "bars": [
    {"label": "1. 首屏曝光触达", "val": "100.0% (120万)", "pct": 100, "c": "blue"},
    {"label": "2. 核心功能点击", "val": "64.2% (77万)", "pct": 64, "c": "cyan"},
    {"label": "3. 首次任务完成", "val": "48.8% (58.5万)", "pct": 49, "c": "emerald"},
    {"label": "4. 次日留存转化", "val": "31.5% (37.8万)", "pct": 32, "c": "amber"}
  ]
}
```

---

## 4. Built-in 40+ Vector SVG Icon Keys

Pass any of these keys to section `"icon"` or callout `"icon"`:
- **Strategy & Goals**: `compass`, `target`, `flag`, `crosshair`, `crown`, `star`, `trophy`, `award`
- **Process & Tech**: `layers`, `cpu`, `database`, `server`, `terminal`, `git-merge`, `sliders`, `wrench`, `hard-drive`, `key`
- **Metrics & Growth**: `chart`, `trending-up`, `pie-chart`, `bar-chart`, `activity`, `dollar`, `gem`, `arrow-up`, `sprout`
- **Risk & Status**: `alert`, `flame`, `shield`, `lock`, `siren`, `octagon`, `bug`, `ban`, `bell`, `check-circle`, `check`, `clock`
- **People & Ops**: `users`, `globe`, `briefcase`, `scale`, `megaphone`, `message`, `gift`, `share`, `smile`, `wand`, `brain`, `lightbulb`, `sparkles`, `zap`, `rocket`, `heart-pulse`
