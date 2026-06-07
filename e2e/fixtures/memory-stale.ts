import type { RequestMemory } from "../../packages/orchestrator/src/memory/types.js";

/**
 * 模拟"历史 run 的某个文件已被重构掉"的场景。
 *
 * 用途：让 LocateAgent 的 stat 检测发现失效路径，触发 recall.stale → attempt+1 演示。
 *
 * 设计：entities 与真实 add-field run 完全一致，确保会被召回为 top-1；
 * 但 changedFiles 含一个虚构的 .OLD.jsx 路径——Conduit 里不存在。
 */
export const M_STALE: RequestMemory = {
  runId: "fix-stale-add-field-archaic",
  ts: 1779000000000,  // 较早时间戳
  summary: "在文章卡片显示阅读时长（历史路径示例，本条用于陈旧失效演示）",
  skillUsed: "add-field",
  entities: {
    domainObjects: ["article"],
    operations: ["add-virtual-field", "calculate-article-estimated-reading-time"],
    affectedLayers: ["db", "backend", "frontend"],
    fieldsAdded: ["readingTime"],
    uiSurfaces: ["ArticleMeta", "ArticlesPreview"],
  },
  // 故意构造：第一个是真实存在的，后两个是失效的（.OLD 后缀）
  changedFiles: [
    "backend/models/Article.js",                                              // 真实存在
    "frontend/src/components/ArticleMeta/ArticleMeta.OLD.jsx",                 // 不存在
    "frontend/src/components/ArticlesPreview/ArticlesPreview.OLD.jsx",         // 不存在
  ],
  clarifications: [
    { q: "阅读速度是否用默认 200 字/分钟？", a: "是" },
    { q: "显示格式是否为 X min read？", a: "是" },
  ],
  outcome: "verified",
};
