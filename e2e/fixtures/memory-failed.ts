import type { RequestMemory } from "../../packages/orchestrator/src/memory/types.js";

/**
 * 模拟一条"verify 当时未通过"的 add-field 历史 run，用于 RecallCard 截图：
 *   - 整张卡片 0.65 透明 + 灰边
 *   - 左侧红色强调条
 *   - 顶部 ⚠ 警告条
 *   - clarifications 仍可"复用上次答案"但视觉明显降级
 *
 * 注入方式：tsx scripts/inject-failed-fixture.ts
 * 清理：tsx scripts/remove-failed-fixture.ts
 */
export const M_FAILED_DEMO: RequestMemory = {
  runId: "fix-failed-add-field-demo",
  ts: 1779500000000,
  summary: "在文章卡片显示阅读时长（历史尝试，verify 未通过，仅供参考）",
  skillUsed: "add-field",
  entities: {
    domainObjects: ["article"],
    operations: ["add-virtual-field", "calculate-article-estimated-reading-time"],
    affectedLayers: ["db", "backend", "frontend"],
    fieldsAdded: ["readingTime"],
    uiSurfaces: ["ArticleMeta", "ArticlesPreview"],
  },
  changedFiles: [
    "backend/models/Article.js",
    "frontend/src/components/ArticleMeta/ArticleMeta.jsx",
    "frontend/src/components/ArticlesPreview/ArticlesPreview.jsx",
  ],
  clarifications: [
    { q: "阅读速度是否用 200 字/分钟？", a: "用 150 字/分钟（这次没采用）", aspect: "calculation-rule" },
    { q: "格式如何？", a: "X 分钟阅读（中文）", aspect: "display-position" },
  ],
  outcome: "failed",
};
