---
name: add-field
description: 在文章/实体上新增或展示一个字段类需求（如"在文章卡片显示阅读时长""给文章加 status 字段"）
---

## 适用场景
"在文章上显示/新增某个字段"这类需求，包括计算字段（阅读时长、字数）和持久化字段（status、可见性等）。

## 实现指引
- 字段定义在 `backend/models/Article.js`。
  - **计算/派生字段**：用 Sequelize `DataTypes.VIRTUAL`，写 getter，不落库、不需要 migration。
  - **持久化字段**：用真实列类型（如 `STRING` + `isIn` 校验枚举），并且**必须同时新建一个 migration** 给对应的表加列。migration 里的表名要严格照抄仓库里既有的真实表名（见仓库概览的"既有数据库表名"，如 `Articles` 而非 `articles`）。
  - 若新字段需要被前端读取，注意检查 model 的序列化逻辑（toJSON）是否会把它带出来。
- 创建/更新文章的 controller（`backend/controllers/articles.js` 的 createArticle / updateArticle）若要支持写入该字段，必须在解构 `req.body.article` 时显式取出该字段并存入。
- 前端展示常见落点：`frontend/src/components/ArticleMeta/ArticleMeta.jsx`（接收并渲染）、`frontend/src/components/ArticlesPreview/ArticlesPreview.jsx`（把字段从 article 传给 ArticleMeta）。具体以仓库实际组件为准。

## 需要澄清的点
- 这个字段是**用户填写/设置**的，还是**系统根据其它数据计算**出来的？
  - 仅当是计算字段时，才需要进一步澄清"计算规则"（如：正文字数 / 200 向上取整，最少 1 分钟）。用户填写型字段不要问计算规则。
- 字段的合法取值范围（枚举值有哪些、默认值是什么）。
