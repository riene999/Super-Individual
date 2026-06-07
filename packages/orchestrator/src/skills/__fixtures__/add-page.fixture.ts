import type { ClarifiedRequest } from "../../types.js";

/** 演示用例：新增热门标签榜页面 */
const fixture: ClarifiedRequest = {
  summary: "新增热门标签榜页面",
  fieldName: "popularTags",
  fieldType: "string",
  displayLocation: "独立页面，URL: /popular-tags",
  businessRule: "查询所有标签按其关联的文章数量降序排列，前 20 条，每条返回 { name, articlesCount }。前端展示为有序列表",
  clarifyingQuestions: [],
};

export default fixture;
