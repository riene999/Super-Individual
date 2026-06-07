import type { RequestMemory } from "../../packages/orchestrator/src/memory/types.js";

// ────────────────────────────────────────────────────────────
// memory fixtures — 独立于 store.jsonl，保证测试稳定
// ────────────────────────────────────────────────────────────

/** 真实抽取：add-field readingTime */
export const M_FIELD: RequestMemory = {
  runId: "fix-field-1",
  ts: 1780000000000,
  summary: "每篇文章卡片展示基于默认200字/分钟计算的预计阅读时长",
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
    { q: "阅读速度是否用默认 200 字/分钟？", a: "是" },
    { q: "显示格式是否为 X min read？", a: "是" },
  ],
  outcome: "verified",
};

/** 人造：同 skill 不同需求（字数统计），验同 skill 高度召回 */
export const M_FIELD_2: RequestMemory = {
  runId: "fix-field-2",
  ts: 1780000010000,
  summary: "在文章卡片显示正文字数",
  skillUsed: "add-field",
  entities: {
    domainObjects: ["article"],
    operations: ["add-virtual-field"],
    affectedLayers: ["backend", "frontend"],
    fieldsAdded: ["wordCount"],
    uiSurfaces: ["ArticleMeta", "ArticlesPreview"],
  },
  changedFiles: [
    "backend/models/Article.js",
    "frontend/src/components/ArticleMeta/ArticleMeta.jsx",
    "frontend/src/components/ArticlesPreview/ArticlesPreview.jsx",
  ],
  clarifications: [{ q: "是否含空格？", a: "不含" }],
  outcome: "verified",
};

/** 真实抽取：add-filter wordCountRange */
export const M_FILTER: RequestMemory = {
  runId: "fix-filter-1",
  ts: 1780000020000,
  summary: "文章列表按字数区间筛选，分为短文/中等/长文三类",
  skillUsed: "add-filter",
  entities: {
    domainObjects: ["article"],
    operations: ["add-list-filter"],
    affectedLayers: ["backend", "frontend"],
    fieldsAdded: ["wordCountRange"],
    uiSurfaces: ["FeedToggler"],
  },
  changedFiles: [
    "backend/controllers/articles.js",
    "frontend/src/services/getArticles.js",
    "frontend/src/hooks/useArticles.js",
    "frontend/src/components/FeedToggler/FeedToggler.jsx",
  ],
  clarifications: [{ q: "边界值归属？", a: "归下一档" }],
  outcome: "verified",
};

/** 真实抽取：add-page popularTags */
export const M_PAGE: RequestMemory = {
  runId: "fix-page-1",
  ts: 1780000030000,
  summary: "新增热门标签榜页面",
  skillUsed: "add-page",
  entities: {
    domainObjects: ["tag", "article"],
    operations: ["add-hot-tag-rank-page", "stat-tag-associated-article-count"],
    affectedLayers: ["backend", "frontend"],
    fieldsAdded: [],
    uiSurfaces: ["TagArticleCount"],
  },
  changedFiles: [
    "backend/routes/tagArticleCount.js",
    "backend/index.js",
    "frontend/src/routes/TagArticleCount.jsx",
    "frontend/src/main.jsx",
  ],
  clarifications: [],
  outcome: "verified",
};

/** 人造：跟 M_FIELD 实体相同但 outcome=failed，验证降权 0.5× */
export const M_FAILED_TWIN: RequestMemory = {
  ...M_FIELD,
  runId: "fix-failed-twin",
  ts: 1780000040000,
  outcome: "failed",
};

export const ALL: RequestMemory[] = [M_FIELD, M_FIELD_2, M_FILTER, M_PAGE, M_FAILED_TWIN];
