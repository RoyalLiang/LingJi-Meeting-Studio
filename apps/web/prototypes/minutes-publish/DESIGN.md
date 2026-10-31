---
name: "聆记 · 纪要导出与会议扩展原型"
description: "V4 浅色专业工作台的实际样式记录；待用户验收，仅作用于本目录"
colors:
  frame: "#f4f6f5"
  surface: "#fff"
  subtle: "#f7f9f8"
  raised: "#edf1ee"
  ink: "#202b25"
  muted: "#637068"
  line: "#e4e9e6"
  control: "#cdd8d1"
  accent: "#25694e"
  accent-hover: "#1e573f"
  accent-soft: "#edf5ef"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.5px"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.6
  section:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.6
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  helper:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  control: "8px"
  panel: "12px"
  sheet: "16px"
spacing:
  compact: "4px"
  small: "8px"
  control: "12px"
  medium: "16px"
  mobile-gutter: "18px"
  section: "24px"
  desktop-gutter: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-text:
    textColor: "{colors.accent}"
    typography: "{typography.label}"
    padding: "5px 0"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
  work-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
---

# Design System: 聆记 · 纪要导出与会议扩展原型

## Overview

**Creative North Star: "留白有序的会议工作台"**

以白色工作面承载会议内容，浅中性框架分隔导航，克制玉绿标记主操作、选中与键盘焦点。密度来自紧凑的控件和稳定的分隔线，阅读区保留呼吸空间。

本文件描述本目录 V4 隔离原型的实际样式，属于待用户验收的视觉提案；不替代全局产品设计系统。保留现有聆记标识，使用本地系统字体，不引入展示字体、摄影或插画。

**Key Characteristics:**

- 白色主体与中性导航
- 玉绿只承担操作和状态强调
- 单框分区，避免层层卡片
- 桌面并列、手机单区切换

## Colors

### Primary

- **克制玉绿（accent）**：主操作、激活页签、选中态与焦点。悬停使用 accent-hover，柔和选中底色使用 accent-soft。

### Neutral

- **中性框架（frame）与白色工作面（surface）**：导航背景与主要阅读、操作区域。
- **淡灰绿层（subtle、raised）**：辅助区和低强度分层。
- **墨色正文（ink）与灰绿辅助字（muted）**：内容与元信息。
- **细分隔线（line）与控件描边（control）**：面板边界和可操作字段。

**The Restrained Jade Rule.** 玉绿用于主要操作、选中与焦点；长文本和主工作面使用中性色。

## Typography

**Body Font:** 使用 frontmatter 中的系统无衬线字体栈；中文跟随 PingFang SC、Microsoft YaHei 等可用字体。没有独立展示字体。

- 页面主标题使用 headline；面板标题使用 title；小节标题使用 section。
- 正文使用 body；说明段落通常为 13px、1.75 行高，控件使用 label；常规辅助信息使用 helper。
- 文档标题为 22px，结果标题为 20px；正文为 14px。长内容使用约 1.85–1.95 行高，结果区在手机上将标题收至 19px。
- 个别版本标签为 11px；它们不承担正文信息，不作为通用正文尺度。

**The Readable Context Rule.** 辅助信息保持次级层级，同时让当前会议名称、版本与只读范围在助手中可见。

## Layout

桌面采用左导航加白色框页：导航宽 224px，1250px 以下收至 208px，1100px 以下隐藏。白色框页采用细边框、sheet 圆角和 8px 外侧留白；内部常用 32px 水平留白，1250px 以下为 24px，手机内容为 18px。

扩展中心是一个带分隔线的主从面板。助手为约 0.95:1.05 的等高双栏；900px 以下等分，内部对话和结果各自滚动。飞书区域并列预览与设置栏。桌面间距以 8px 为主要节奏，也保留源码中用于紧凑阅读的 18px 等局部值。

700px 以下切换结构：扩展中心一次显示列表或详情；助手切换对话/分析结果；导出切换设置/预览。当前会议名称、版本和只读范围保留在助手内容之前。画板保持自身滚动边界，不能撑宽页面。顶部原型顺序导航处于正常文档流，不能覆盖操作区；360px 以下继续收紧导航标题。

## Elevation & Depth

**The Flat Workbench Rule.** 工作面依靠边框、留白和淡底色分层；阴影只服务对话框与临时反馈。

- 对话框：`0 16px 64px #182d2430`，配合半透明遮罩。
- 临时提示：`0 5px 24px #1c342622`。
- 工作台、主从面板和结果区静态无阴影。

## Shapes

控件采用 control 圆角，复合面板采用 panel 圆角，主框页和对话框采用 sheet 圆角。小标签为 5px；头像为圆形。面板以 1px 细边框和内部直线分隔保持结构；分区不再逐层套卡片。

## Components

- **按钮**：桌面最小高度 38px，字段最小高度 40px；手机主要按钮、页签与原型导航触控区为 44px。主按钮为玉绿配白字；次按钮白底描边；文字操作使用玉绿，悬停下划线。禁用按钮降低透明度并保留不可用光标。
- **输入**：白底、control 描边与 8px 圆角；字段悬停加强描边。统一键盘焦点为 2px 玉绿外轮廓、3px 间隔。多行输入允许纵向调整。
- **页签与导航**：桌面扩展页签以玉绿文字和下划线标记激活；手机内容页签使用淡底轨道与白色选中面。导航选中态采用柔和底色，状态仍有文字。
- **标签**：小型低对比底色配辅助文字，承载版本、来源或状态；不代替标题。
- **主从面板**：同一个白框内，列表通过行分隔线与选中淡底组织，详情使用标题、说明与键值信息；手机详情提供返回入口。
- **对话与独立结果**：同框并列，对话输入保持在栏底，结果正文独立滚动；草稿编辑属于结果区，纪要身份和只读范围不随页签丢失。
- **状态与反馈**：保留等待、模拟流式、停止、错误、候选更新、人工草稿和模拟回执的可见文字。颜色不能独自表达状态。按钮使用 0.16s 的背景/边框过渡；减少动态偏好关闭动画与过渡。

## Do's and Don'ts

### Do:

- Do 保留现有聆记标识、白色工作面和克制玉绿。
- Do 在窄屏用页签切换设置/预览、对话/结果；扩展中心切换列表/详情。
- Do 让关键控件保持可见焦点，并保留明确的模拟、只读和独立草稿说明。

### Don't:

- Don't 用装饰阴影或重复嵌套卡片替代内容分区。
- Don't 将原型顺序导航悬浮在主要操作之上。
- Don't 将此原型的视觉提案或模拟状态描述为已获最终验收或生产能力。

此文档不将示例文档中的小型眉题、个别 Unicode 壳层符号或临时预览标识确立为可扩展的设计规范。颜色渐阶仅在 sidecar 中为工具生成预览，不是新增运行时 token。
