import { defineSkill } from "./base.js";
import type { ClarifiedRequest } from "../types.js";

// fieldName 是 camelCase（如 "popularTags"），转 PascalCase 页面名 + kebab-case URL
function deriveNames(req: ClarifiedRequest) {
  const camel = req.fieldName || "newPage";
  const pascal = camel.charAt(0).toUpperCase() + camel.slice(1);
  const kebab = camel.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");
  return { pageName: pascal, routeUrl: kebab, fileBase: camel };
}

const skill = defineSkill({
  name: "add-page",
  description: "新增一个只读页面，适用于「新增 X 页面 / X 榜 / X 排行」类需求，会创建后端聚合接口 + 前端页面组件并注册到路由表。",

  possibleAspects: ["route-path", "page-name", "data-source", "display-position", "sort-rule"],

  aspectQuestionTemplate: {
    "route-path": {
      question: "请说明前端路由路径（kebab-case）",
      example: "例如：/popular-tags / /top-authors / /trending-articles",
    },
    "page-name": {
      question: "请说明页面组件名（PascalCase）",
      example: "例如：PopularTags / TopAuthors / TrendingArticles",
    },
    "data-source": {
      question: "请说明后端从哪些表/字段聚合数据",
      example: "例如：Tag 表 JOIN ArticleTag 按文章数 COUNT(*) 聚合；或 User 表按 followersCount",
    },
    "display-position": {
      question: "请说明页面在导航上的入口",
      example: "例如：Navbar 加 \"Popular Tags\" 链接；或独立菜单项位于 \"Settings\" 上方",
    },
    "sort-rule": {
      question: "请说明结果的排序规则",
      example: "例如：articlesCount 降序，并列时按字典序；或最近 7 天 favoritesCount 降序",
    },
  },

  requiredWords: ["页面", "页", "page", "榜", "排行", "leaderboard", "ranking"],

  matchWords: [
    "页面", "新增页", "新页", "页", "新建页",
    "榜", "排行", "排行榜", "热门", "聚合",
    "page", "new page", "ranking", "leaderboard", "popular", "aggregate",
  ],
  matchThreshold: 3,

  buildSteps: (req) => {
    const { pageName, routeUrl, fileBase } = deriveNames(req);
    return [
      {
        path: `backend/routes/${fileBase}.js`,
        mode: "create",
        instruction: `创建 Express Router 文件。需求：${req.businessRule}。导出方式与参考样例一致（CommonJS module.exports = router）。复用 ../models 里现有 Model（如 Article / Tag / User）。挂在路径 GET / 返回聚合结果 JSON。`,
      },
      {
        path: "backend/index.js",
        mode: "modify",
        instruction: `在已有 5 条 app.use("/api/...") 之后再加一行注册：app.use("/api/${routeUrl}", ${fileBase}Routes)，并在顶部 require 段加一行 const ${fileBase}Routes = require("./routes/${fileBase}");。**只动这两处，其他保留**。`,
      },
      {
        path: `frontend/src/routes/${pageName}.jsx`,
        mode: "create",
        instruction: `创建 React 函数组件 ${pageName}，default export。从 /api/${routeUrl} fetch 数据（用 axios，参考样例的 import 与调用方式），展示位置/样式参考：${req.displayLocation}。需求：${req.businessRule}。`,
      },
      {
        path: "frontend/src/main.jsx",
        mode: "modify",
        instruction: `在顶部 import 段加一行：import ${pageName} from "./routes/${pageName}";，并在 <Routes><Route element={<App />}> 块里现有 "profile/:username" 路由的同级追加：<Route path="${routeUrl}" element={<${pageName} />} />。**只动这两处，其他路由保留**。`,
      },
    ];
  },

  // create-mode 文件载入同类参考样例，让 LLM 仿照 Conduit 风格
  referenceFor: (step) => {
    if (step.mode !== "create") return null;
    if (step.path.startsWith("backend/routes/"))   return "backend/routes/tags.js";
    if (step.path.startsWith("frontend/src/routes/")) return "frontend/src/routes/HomeArticles.jsx";
    return null;
  },
});

const baseMatch = skill.match.bind(skill);
skill.match = (req) => {
  const haystack = [req.summary, req.fieldName, req.businessRule, req.displayLocation].join(" ").toLowerCase();
  const mentionsTab = haystack.includes("tab") || haystack.includes("标签页");
  const mentionsExistingPage = haystack.includes("现有") || haystack.includes("existing");
  if (mentionsTab && mentionsExistingPage) return 0;
  return baseMatch(req);
};

export default skill;
