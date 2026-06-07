from __future__ import annotations

import json

from orchestrator.agents.aspect_scan import AspectScanItem
from orchestrator.llm.doubao import LLMClient
from orchestrator.skills.base import Skill
from orchestrator.types import ClarifiedRequest, ClarifyingQuestion


def _parse_json(text: str) -> dict:
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.endswith("```"):
            s = s[:-3]
    return json.loads(s.strip())


async def analyze(raw_text: str, llm: LLMClient) -> ClarifiedRequest:
    result = await llm.chat(
        [
            {"role": "system", "content": "你是代码助手，只输出 JSON，不输出任何解释。"},
            {
                "role": "user",
                "content": f"""将下面的 PM 需求解析成 JSON：
- summary: 一句话摘要
- fieldName: camelCase 字段名；无具体字段则给 "n/a"
- fieldType: integer|float|string|boolean；无关时填 string
- displayLocation: 展示位置
- businessRule: 计算/展示规则

不要在输出里包含 clarifyingQuestions。

输入：{raw_text}
输出：""",
            },
        ],
        None,
        {"agent": "clarify:analyze"},
    )
    data = _parse_json(result["text"])
    return ClarifiedRequest(
        summary=str(data.get("summary", "")),
        fieldName=str(data.get("fieldName", "")),
        fieldType=data.get("fieldType", "string"),
        displayLocation=str(data.get("displayLocation", "")),
        businessRule=str(data.get("businessRule", "")),
        clarifyingQuestions=[],
    )


async def resolve(raw_text: str, partial: ClarifiedRequest, answers: dict[str, str], llm: LLMClient) -> ClarifiedRequest:
    qa = "\n\n".join(f"Q: {q}\nA: {a}" for q, a in answers.items())
    result = await llm.chat(
        [
            {"role": "system", "content": "你是产品需求分析专家。根据 PM 原始需求和澄清问答，输出最终结构化 JSON。"},
            {"role": "user", "content": f"原始需求：{raw_text}\n\n初步解析：{partial.__dict__}\n\n澄清问答：\n{qa}"},
        ],
        None,
        {"agent": "clarify:resolve"},
    )
    data = _parse_json(result["text"])
    return ClarifiedRequest(
        summary=str(data.get("summary", partial.summary)),
        fieldName=str(data.get("fieldName", partial.fieldName)),
        fieldType=data.get("fieldType", partial.fieldType),
        displayLocation=str(data.get("displayLocation", partial.displayLocation)),
        businessRule=str(data.get("businessRule", partial.businessRule)),
        clarifyingQuestions=[],
        answers=answers,
    )


async def generic_questions(raw_text: str, partial: ClarifiedRequest, llm: LLMClient, run_id: str) -> list[ClarifyingQuestion]:
    try:
        result = await llm.chat(
            [
                {"role": "system", "content": "你是产品需求澄清助手。只输出严格 JSON，不要输出解释。"},
                {
                    "role": "user",
                    "content": f"""判断下面的需求在进入代码修改前是否还有必须澄清的地方。

原始需求：{raw_text}

当前结构化理解：
{partial.__dict__}

输出格式：{{"questions":["问题1","问题2"]}}

要求：
- 返回 0 到 3 个问题。
- 只问真正会影响代码修改安全性的问题。
- 如果需求已经清楚，返回 {{"questions":[]}}。""",
                },
            ],
            {"temperature": 0.1, "maxTokens": 512},
            {"agent": "clarify:generic", "runId": run_id},
        )
        data = _parse_json(result["text"])
        questions = data.get("questions", [])
        if not isinstance(questions, list):
            return []
        return [ClarifyingQuestion(q=str(q).strip(), aspect="other") for q in questions[:3] if str(q).strip()]
    except Exception:
        return []


def _template_to_question(skill: Skill, aspect: str) -> str | None:
    tmpl = skill.aspect_question_template.get(aspect)
    if not tmpl:
        return None
    return f"{tmpl.get('question', '')}（{tmpl.get('example', '')}）"


async def build_questions_from_aspects(
    scan_items: list[AspectScanItem],
    skill: Skill,
    llm: LLMClient,
    run_id: str,
) -> list[ClarifyingQuestion]:
    skill_aspects = set(skill.possible_aspects)
    askable = [item for item in scan_items if item.aspect in skill_aspects and item.status == "needs-asking"]
    if not askable:
        return []

    base = []
    for item in askable:
        q = _template_to_question(skill, item.aspect)
        if q:
            base.append(ClarifyingQuestion(q=q, aspect=item.aspect))
    if len(base) <= 1:
        return base

    try:
        result = await llm.chat(
            [
                {
                    "role": "system",
                    "content": "你是文案打磨助手。把若干机械的追问句改写得更自然、更连贯，但保留所有“例如”示例与字段含义。只输出 JSON 数组。",
                },
                {
                    "role": "user",
                    "content": f"""把以下追问句改写得更自然连贯，但严格保留括号内“例如”示例与字段含义。
输出与输入等长 JSON 数组，元素为 {{"q": "改写后的问句", "aspect": "原 aspect"}}。

输入：
{json.dumps([q.__dict__ for q in base], ensure_ascii=False, indent=2)}

输出：""",
                },
            ],
            None,
            {"agent": "clarify:polish", "runId": run_id},
        )
        polished = _parse_json(result["text"])
    except Exception:
        return base

    if not isinstance(polished, list) or len(polished) != len(base):
        return base
    out: list[ClarifyingQuestion] = []
    for index, original in enumerate(base):
        item = polished[index]
        q = item.get("q") if isinstance(item, dict) else None
        out.append(ClarifyingQuestion(q=q.strip() if isinstance(q, str) and q.strip() else original.q, aspect=original.aspect))
    return out
