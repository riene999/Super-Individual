from __future__ import annotations

import json

from orchestrator.llm.doubao import LLMClient
from orchestrator.memory.layers import infer_layers
from orchestrator.types import ClarificationQA, ExtractedEntities


def _to_str_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(x).strip() for x in value if str(x).strip()]


async def extract_entities(
    llm: LLMClient,
    *,
    run_id: str,
    summary: str,
    skill_used: str | None,
    changed_files: list[str] | None = None,
    clarifications: list[ClarificationQA] | None = None,
) -> ExtractedEntities:
    affected_layers = infer_layers(changed_files or [])
    try:
        qa = "\n".join(f"Q: {c.q}\nA: {c.a}" for c in (clarifications or [])) or "(无)"
        files_line = ", ".join(changed_files or []) or "(尚未生成，基于需求语义推测)"
        result = await llm.chat(
            [
                {"role": "system", "content": "你是代码变更结构化分析器。只输出 JSON，不加解释。"},
                {
                    "role": "user",
                    "content": f"""从下面的代码变更信息中抽取结构化业务实体。

摘要：{summary}
Skill：{skill_used or "generic"}
改动文件：{files_line}
澄清问答：
{qa}

输出严格 JSON：
{{"domainObjects":[],"operations":[],"fieldsAdded":[],"uiSurfaces":[]}}""",
                },
            ],
            {"temperature": 0.1, "maxTokens": 512},
            {"agent": "memory:extract", "runId": run_id},
        )
        text = result["text"].strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].removesuffix("```").strip()
        data = json.loads(text)
        return ExtractedEntities(
            domainObjects=_to_str_list(data.get("domainObjects")),
            operations=_to_str_list(data.get("operations")),
            affectedLayers=affected_layers,
            fieldsAdded=_to_str_list(data.get("fieldsAdded")),
            uiSurfaces=_to_str_list(data.get("uiSurfaces")) if changed_files else [],
        )
    except Exception:
        return ExtractedEntities(operations=[skill_used] if skill_used else [], affectedLayers=affected_layers)

