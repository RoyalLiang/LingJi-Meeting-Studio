// Original, curated meeting terms. Person and place names remain account/directory data.
export const commonVocabularyVersion = '2026-10-29.1';
const terms = '需求评审 架构评审 设计评审 代码评审 项目启动 项目复盘 需求澄清 需求分析 需求变更 产品演示 迭代计划 迭代复盘 上线评审 版本发布 灰度发布 回归测试 集成测试 冒烟测试 性能测试 验收测试 用户验收 试运行 联调验收 技术交底 项目交付 交付验收 排期评估 进度同步 风险评估 故障复盘 问题排查 应急预案 容量规划 数据迁移 权限管理 访问控制 数据备份 业务流程 行动事项 会议纪要 工作目录 转录校对 培训课程 客户访谈 用户访谈 面试评估 圆桌讨论 预算评审 合同评审 采购评审 市场调研 场景分析 方案评审 运营复盘 质量评审 安全评审'.split(' ');
export const commonVocabulary = terms.map(text => ({ kind: 'terms', text, aliases: [], source: 'common', packVersion: commonVocabularyVersion }));
