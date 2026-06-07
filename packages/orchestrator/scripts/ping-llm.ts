import "dotenv/config";
import { createDoubaoClient } from "../src/llm/doubao.js";

const llm = createDoubaoClient();

const result = await llm.chat([
  { role: "system", content: "你是一个助手，请简洁回答。" },
  { role: "user", content: "用一句话解释什么是阅读时间（reading time）字段。" },
], undefined, { agent: "script:ping-llm" });

console.log("回答:", result.text);
