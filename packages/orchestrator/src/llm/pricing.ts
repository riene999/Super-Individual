/**
 * LLM 价目表。
 * 数值单位：人民币元 / 1k tokens。
 * 价格生效日期：2026-05-29（豆包 ARK 公开价）。请定期人工校核。
 */

export interface ModelPrice {
  input: number;   // ¥/1k tokens
  output: number;  // ¥/1k tokens
}

export const PRICING: Record<string, ModelPrice> = {
  // 豆包通用模型（EP 走兼容接口；EP-ID 本身不是模型名，
  // 这里以"default"兜底匹配——实际场景里 EP 背后挂的是 Doubao-1.5-pro 或同档模型）
  default:           { input: 0.0008, output: 0.0020 },
  "doubao-1.5-pro":  { input: 0.0008, output: 0.0020 },
  "doubao-1.5-lite": { input: 0.0003, output: 0.0006 },
};

export function priceLookup(model: string): ModelPrice {
  return PRICING[model] ?? PRICING.default;
}

export function estimateCostCNY(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceLookup(model);
  return (promptTokens / 1000) * p.input + (completionTokens / 1000) * p.output;
}
