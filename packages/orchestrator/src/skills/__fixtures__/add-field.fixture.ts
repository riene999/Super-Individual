import type { ClarifiedRequest } from "../../types.js";

/** 演示用例：readingTime 字段 */
const fixture: ClarifiedRequest = {
  summary: "在文章卡片展示预计阅读时长",
  fieldName: "readingTime",
  fieldType: "integer",
  displayLocation: "ArticleMeta 组件，日期旁边",
  businessRule: "正文字数 / 200 向上取整，单位分钟，最少 1 分钟",
  clarifyingQuestions: [],
};

export default fixture;
