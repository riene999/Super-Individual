---
name: add-filter
description: 为文章列表新增筛选项（"按 X 筛选""只看 X"类需求），通常要同时改后端 query 参数和前端筛选 UI
---

## 适用场景
给文章列表加一个筛选维度，例如按字数/篇幅、发布时间、收藏数等过滤。

## 实现指引
端到端通常涉及四层，缺一会导致筛选"半通"：
- `backend/controllers/articles.js` 的 `allArticles`：扩展 `req.query`，新增筛选维度并转成 Sequelize 查询条件（如 `where` + `Op.between` / `Op.gte`），保留现有 author/tag/favorited 逻辑。
- `frontend/src/services/getArticles.js`：给请求函数加上新参数，并拼进对应的列表接口 URL，保留现有 URL 分支。
- `frontend/src/hooks/useArticles.js`：hook 增加该入参，放进 useEffect 依赖并透传给 service。
- `frontend/src/components/FeedToggler/FeedToggler.jsx`（或实际的筛选 UI 容器）：追加筛选入口控件。

## 需要澄清的点
- 按什么字段筛选、可选项有哪些（如：短文/中等/长文，或具体数值区间）。
- 筛选 UI 放在页面哪个位置。
- 是否影响默认列表（不选时的默认行为）。
