import type { ClarifiedRequest } from "../../types.js";

/** 演示用例：按字数区间筛选文章 */
const fixture: ClarifiedRequest = {
  summary: "在文章列表新增按字数区间筛选（短文/中等/长文）",
  fieldName: "lengthCategory",
  fieldType: "string",
  displayLocation: "FeedToggler 的 nav-pills 末尾，作为可点击 tab",
  businessRule: "三个固定选项：short(body 长度 < 200)、medium(200~1000)、long(>1000)；点击后通过 query 参数 lengthCategory=short|medium|long 传到后端，后端用 Sequelize where + Op.between 过滤",
  clarifyingQuestions: [],
};

export default fixture;
