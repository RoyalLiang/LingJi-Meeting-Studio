# AI Worker

负责会后纪要、行动项提取、主题切片和问答索引。

## 责任边界

- 订阅 session 完成事件
- 拉取 final transcript
- 生成摘要和行动项
- 写回结构化结果

## 首批实现顺序

1. session.completed 消费
2. 摘要生成
3. 行动项提取
4. 主题分段
