import OpenAI from "openai";
import { emit } from "../events/store.js";
import { estimateCostCNY } from "./pricing.js";

export interface Msg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
}

/** 每次 chat 调用的元数据（必填）。调用方必须显式指明 agent。 */
export interface ChatMeta {
  agent: string;     // 必填：哪个 agent 在调（如 "clarify:analyze"、"code:add-field"）
  runId?: string;    // 可选：脚本场景没有 runId。工厂可预绑定。
  attempt?: number;  // 默认 1。code 阶段重试时由 orchestrator 注入 ≥2
}

export interface ChatResult {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    costCNY: number;
  };
}

export interface LLMClient {
  /** meta 必填，避免某个调用点忘了打标导致指标面板出现"未知桶" */
  chat(messages: Msg[], opts: ChatOpts | undefined, meta: ChatMeta): Promise<ChatResult>;
}

/**
 * 工厂层可预绑定 runId，调用点只关心 agent。
 * 无 runId 的 LLM 调用（脚本场景）会写到 events/_global.jsonl
 */
export function createDoubaoClient(defaults: { runId?: string } = {}): LLMClient {
  const apiKey = process.env.DOUBAO_API_KEY;
  const epId = process.env.DOUBAO_EP_ID;
  const baseURL = process.env.DOUBAO_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3";

  if (!apiKey) throw new Error("DOUBAO_API_KEY env var is not set");
  if (!epId) throw new Error("DOUBAO_EP_ID env var is not set");

  const client = new OpenAI({ apiKey, baseURL });

  return {
    async chat(messages, opts = {}, meta) {
      const start = Date.now();

      const response = await client.chat.completions.create({
        model: epId,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 4096,
      });

      const latencyMs = Date.now() - start;
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;
      const text = response.choices[0]?.message?.content ?? "";
      const costCNY = estimateCostCNY(epId, promptTokens, completionTokens);

      // 合并工厂默认与调用方 meta
      const effectiveRunId = meta.runId ?? defaults.runId;
      const attempt = meta.attempt ?? 1;

      console.log(
        `[LLM ${meta.agent}${attempt > 1 ? `#${attempt}` : ""}] tokens=${promptTokens}+${completionTokens} latency=${latencyMs}ms cost≈¥${costCNY.toFixed(4)}`
      );

      // 持久化事件（runId 缺失走全局桶）
      emit(effectiveRunId ?? "_global", "llm.call", {
        agent: meta.agent,
        model: epId,
        attempt,
        promptTokens,
        completionTokens,
        latencyMs,
        costCNY,
      });

      return { text, usage: { promptTokens, completionTokens, latencyMs, costCNY } };
    },
  };
}
