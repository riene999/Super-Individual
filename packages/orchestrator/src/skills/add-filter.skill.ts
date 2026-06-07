import { defineSkill } from "./base.js";

export default defineSkill({
  name: "add-filter",
  description: "为文章列表新增筛选项，适用于「按 X 筛选」「只看 X」类需求，会扩展后端 query 参数和前端筛选 UI。",

  possibleAspects: ["filter-criteria", "filter-options", "filter-ui-placement", "data-source"],

  aspectQuestionTemplate: {
    "filter-criteria": {
      question: "请说明按什么字段筛选",
      example: "例如：按 body 字数 / 按发布时间 / 按 favoritesCount",
    },
    "filter-options": {
      question: "请说明可选项有哪些（含分档边界）",
      example: "例如：短文 (<200 字) / 中等 (200-1000) / 长文 (>1000)；或 7 天 / 30 天 / 全部",
    },
    "filter-ui-placement": {
      question: "请说明筛选 UI 放在哪里、用什么交互",
      example: "例如：FeedToggler 的 nav-pills 末尾追加 tab；或 PopularTags 区域上方加 select",
    },
    "data-source": {
      question: "请说明后端怎么实现筛选",
      example: "例如：Sequelize.where + Op.between 范围；或 SQL: WHERE LENGTH(body) BETWEEN ?",
    },
  },

  // 必选词：没出现"筛选/过滤/filter/只看" → 直接 0 分，避免与 add-field 关键词冲突
  requiredWords: ["筛选", "过滤", "filter", "只看", "filter by"],

  matchWords: [
    "筛选", "过滤", "只看", "按",
    "字数", "长文", "短文", "篇幅", "区间", "范围",
    "filter", "by", "word", "length", "range", "short", "long",
  ],
  matchThreshold: 3,

  buildSteps: (req) => [
    {
      path: "backend/controllers/articles.js",
      mode: "modify",
      instruction: `在 allArticles 控制器中扩展 req.query 解析与 Sequelize 查询，新增筛选维度：${req.businessRule}。字段名/参数名约定为 \`${req.fieldName}\`。注意保留现有 author/tag/favorited 筛选逻辑。`,
    },
    {
      path: "frontend/src/services/getArticles.js",
      mode: "modify",
      instruction: `给 getArticles 增加 \`${req.fieldName}\` 参数，并把它拼到 global feed 的 URL（保留现有 favorites/feed/profile/tag 五条 URL 不变，只动 global）。`,
    },
    {
      path: "frontend/src/hooks/useArticles.js",
      mode: "modify",
      instruction: `useArticles hook 增加 \`${req.fieldName}\` 入参，在 useEffect 依赖里加上它，透传给 getArticles。`,
    },
    {
      path: "frontend/src/components/FeedToggler/FeedToggler.jsx",
      mode: "modify",
      instruction: `在 nav-pills 末尾追加筛选 UI（位置：${req.displayLocation}），实现：${req.businessRule}。新组件通过 useFeedContext 读取/更新当前筛选值（如果 FeedContext 暂未暴露该字段，仅在本组件内 useState 即可，不要去改 FeedContext.jsx）。`,
    },
  ],
});
