from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal

from orchestrator.llm.doubao import LLMClient


AspectStatus = Literal["explicit", "from-history", "needs-asking"]
CONFIDENCE_THRESHOLD = 0.7
SYSTEM = "你是需求清晰度分析器。只输出 JSON，不加任何解释。"


@dataclass
class AspectScanItem:
    aspect: str
    status: AspectStatus
    confidence: float
    evidence: str | None = None
    rawStatus: AspectStatus | None = None


@dataclass
class RecalledForScan:
    runId: str
    score: float
    summary: str
    clarifications: list[dict[str, str]]


@dataclass
class AspectScanResult:
    items: list[AspectScanItem]


def _strip_json_fence(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    return cleaned.strip()


def _build_prompt(run_id: str, raw_text: str, candidate_aspects: list[str], recalled_history: list[RecalledForScan]) -> str:
    if not recalled_history:
        hist_block = "(无相似历史 run)"
    else:
        blocks: list[str] = []
        for index, history in enumerate(recalled_history, start=1):
            if history.clarifications:
                qa_list = "\n".join(
                    f"    - [{c.get('aspect') or 'other'}] Q: {c.get('q') or ''}  A: {c.get('a') or ''}"
                    for c in history.clarifications
                )
            else:
                qa_list = "    (无澄清问答)"
            blocks.append(
                f"""历史 {index}: run #{history.runId[:8]} (score {history.score:.2f})
  摘要: {history.summary}
  澄清问答:
{qa_list}"""
            )
        hist_block = "\n\n".join(blocks)

    aspects = "\n".join(f"  - {aspect}" for aspect in candidate_aspects)
    return f"""判断每个候选 aspect 在 PM 输入或历史召回中是否已表达。

PM 当前输入：
"{raw_text}"

候选 aspect 列表（共 {len(candidate_aspects)} 个）：
{aspects}

{hist_block}

对每个候选 aspect 输出一项，status 三选一：
  - explicit:     PM 输入里明确表达了该 aspect 的具体值
  - from-history: PM 输入未提，但某条历史的同 aspect 答案直接适用
  - needs-asking: 上述都不满足

规则（必须遵守）：
  1. evidence 必须引用具体词句，不能写“PM 提到了 X”这种泛泛之言
  2. from-history 仅当历史 clarification 的 aspect 与候选 aspect 完全相同才可使用；不要跨 aspect 硬套
  3. 不确定时降低 confidence，低于 0.7 会被降级为 needs-asking
  4. 仅返回候选列表中的 aspect，不要发明新 aspect
  5. 仅返回 candidateAspects 里的项，不重复、不遗漏

输出严格 JSON：
{{
  "items": [
    {{"aspect": "field-name", "status": "explicit", "evidence": "PM 说'readingTime 字段'", "confidence": 0.95}},
    {{"aspect": "field-type", "status": "from-history", "evidence": "历史 1 答 'VIRTUAL'", "confidence": 0.85}},
    {{"aspect": "display-position", "status": "needs-asking", "confidence": 1.0}}
  ]
}}

现在输出："""


def fallback(candidate_aspects: list[str]) -> AspectScanResult:
    return AspectScanResult([AspectScanItem(aspect=a, status="needs-asking", confidence=0) for a in candidate_aspects])


def parse_and_normalize(raw: str, candidate_aspects: list[str]) -> AspectScanResult:
    data = json.loads(_strip_json_fence(raw))
    raw_items = data.get("items", [])
    if not isinstance(raw_items, list):
        raw_items = []

    valid_aspects = set(candidate_aspects)
    seen: set[str] = set()
    out: list[AspectScanItem] = []

    for item in raw_items:
        if not isinstance(item, dict):
            continue
        aspect = item.get("aspect")
        if not isinstance(aspect, str) or aspect not in valid_aspects or aspect in seen:
            continue
        seen.add(aspect)

        status: AspectStatus = item.get("status") if item.get("status") in ("explicit", "from-history") else "needs-asking"
        raw_confidence = item.get("confidence")
        confidence = raw_confidence if isinstance(raw_confidence, (int, float)) else 0.5
        confidence = max(0.0, min(1.0, float(confidence)))
        evidence = item.get("evidence")
        evidence = evidence.strip() if isinstance(evidence, str) and evidence.strip() else None

        needs_downgrade = status in ("explicit", "from-history") and confidence < CONFIDENCE_THRESHOLD
        out.append(
            AspectScanItem(
                aspect=aspect,
                status="needs-asking" if needs_downgrade else status,
                confidence=confidence,
                evidence=evidence,
                rawStatus=status if needs_downgrade else None,
            )
        )

    for aspect in candidate_aspects:
        if aspect not in seen:
            out.append(AspectScanItem(aspect=aspect, status="needs-asking", confidence=0))

    by_aspect = {item.aspect: item for item in out}
    return AspectScanResult([by_aspect[aspect] for aspect in candidate_aspects])


async def aspect_scan(
    llm: LLMClient,
    *,
    run_id: str,
    raw_text: str,
    candidate_aspects: list[str],
    recalled_history: list[RecalledForScan],
) -> AspectScanResult:
    if not candidate_aspects:
        return AspectScanResult([])

    try:
        result = await llm.chat(
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _build_prompt(run_id, raw_text, candidate_aspects, recalled_history)}],
            {"temperature": 0.1, "maxTokens": 1024},
            {"agent": "clarify:aspect-scan", "runId": run_id},
        )
        return parse_and_normalize(result["text"], candidate_aspects)
    except Exception:
        return fallback(candidate_aspects)


def filter_recall_for_scan(
    matches: list[dict],
    *,
    min_score: float = 0.5,
    top_k: int = 2,
) -> list[RecalledForScan]:
    filtered = [m for m in matches if float(m.get("score", 0)) >= min_score and m.get("outcome") != "failed"]
    filtered.sort(key=lambda m: float(m.get("score", 0)), reverse=True)
    out: list[RecalledForScan] = []
    for match in filtered[:top_k]:
        clarifications = match.get("clarifications") or []
        out.append(
            RecalledForScan(
                runId=str(match.get("runId", "")),
                score=float(match.get("score", 0)),
                summary=str(match.get("summary", "")),
                clarifications=[
                    {"q": str(c.get("q", "")), "a": str(c.get("a", "")), "aspect": str(c.get("aspect", "other"))}
                    for c in clarifications
                    if isinstance(c, dict)
                ],
            )
        )
    return out
