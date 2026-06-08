from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from orchestrator.agents.generic_plan import _clean_json, get_repo_overview, steps_from_file_dicts
from orchestrator.llm.doubao import LLMClient
from orchestrator.types import RepoContext, SkillPlan

MAX_QUESTION_ROUNDS = 3


@dataclass
class PlanLoopOutput:
    status: str  # "need_info" | "ready"
    questions: list[str] = field(default_factory=list)
    title: str = ""
    plan: SkillPlan | None = None


def format_recall_context(matches: list[dict[str, Any]]) -> str:
    """把 recall.matched 的历史候选渲染成一段文本，供 plan agent 参考过往同类需求的处理方式。"""
    if not matches:
        return "（无相似历史需求）"
    lines: list[str] = []
    for m in matches[:3]:
        files = ", ".join(m.get("expectedFiles") or []) or "（未知）"
        lines.append(
            f"- 需求：{m.get('summary', '')}\n  结果：{m.get('outcome', '')}；当时改动文件：{files}"
        )
    return "\n".join(lines)


def _parse_output(text: str, *, force_ready: bool) -> PlanLoopOutput:
    cleaned = _clean_json(text)
    try:
        data = json.loads(cleaned)
    except Exception:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise
        data = json.loads(cleaned[start : end + 1])

    status = str(data.get("status", "")).strip()
    if status == "need_info" and not force_ready:
        questions = [str(q).strip() for q in (data.get("questions") or []) if str(q).strip()][:5]
        if questions:
            return PlanLoopOutput(status="need_info", questions=questions)
        # 声称要问却没给出问题：当作 ready 处理（下面再校验 files）

    # 走到这里要么 status==ready，要么 force_ready，要么没有有效问题 —— 一律按出规划处理
    steps = steps_from_file_dicts(data.get("files"))
    contract = str(data.get("contract", "")).strip()
    title = str(data.get("title", "")).strip()
    return PlanLoopOutput(
        status="ready",
        title=title,
        plan=SkillPlan(skillName="generic", files=steps, contract=contract),
    )


def _build_prompt(
    raw_text: str,
    ctx: RepoContext,
    *,
    skills_context: str,
    code_spec_context: str | None,
    recall_context: str,
    qa_history: list[tuple[str, str]],
    force_ready: bool,
) -> str:
    qa_block = "\n".join(f"Q: {q}\nA: {a}" for q, a in qa_history) or "（暂无）"
    if force_ready:
        decision = (
            "已达到澄清轮次上限，**本轮必须直接给出最终规划**（status=ready），"
            "对仍不明确的地方做出合理默认假设，并把假设写进 contract 或对应文件的 instruction 里。不要再提问。"
        )
    else:
        decision = (
            "若信息已足够规划，输出 status=ready；"
            "若存在**会改变规划结果**的关键歧义，才输出 status=need_info 并给出问题。"
            "能通过合理默认假设解决的，不要提问——直接假设并写进 contract/instruction。最多问 5 个问题。"
        )
    return f"""你是资深全栈代码规划助手，负责把 PM 的自然语言需求转成可执行的文件改动规划。
你可以在信息不足时向 PM 提问，但要克制：只问会改变规划结果的关键问题。

PM 原始需求：
{raw_text}

已有的澄清问答：
{qa_block}

可参考的 skill 知识（领域指引与常见陷阱，按需采纳，不是强制文件清单）：
{skills_context}

仓库概览：
{get_repo_overview(ctx)}

相关代码规范摘要（仓库现有相关文件）：
{code_spec_context or "（暂无代码规范索引）"}

相似历史需求（仅供参考）：
{recall_context}

本轮决策：
{decision}

只输出严格 JSON，二选一：
1) 需要澄清：{{"status":"need_info","questions":["...","..."]}}
2) 规划完成：{{"status":"ready","title":"简短英文/中文标题，供 commit 与分支名","contract":"跨文件必须一致的接口约定","files":[{{"path":"相对路径","mode":"modify|create","instruction":"具体实现说明"}}]}}

规划要求：
- path 相对仓库根目录；mode=modify 的文件须真实存在，mode=create 的须放在符合现有约定的位置。
- **功能要从头管到尾，一个都不能漏**：后端加 controller 必须配路由注册；前端加页面/Tab 必须配路由表和导航入口；加持久化字段必须配 migration。
- contract 把跨文件必须一致的名字钉死（组件名/默认导出名/import 路径/API 路径/字段名与枚举值/函数名等），并照抄既有事实（数据库表名严格按仓库概览里的大小写与单复数，如 Articles）。每个文件的 instruction 必须与 contract 完全一致，不得自行改名。
- instruction 要写清本文件具体改什么，并显式引用 contract 中的名字。
- 文件数按实际需要，不要为凑数硬塞，也不要为省事漏掉配套文件；上限 12 个。
"""


async def plan_step(
    raw_text: str,
    ctx: RepoContext,
    llm: LLMClient,
    *,
    skills_context: str,
    code_spec_context: str | None,
    recall_context: str,
    qa_history: list[tuple[str, str]],
    force_ready: bool,
) -> PlanLoopOutput:
    prompt = _build_prompt(
        raw_text,
        ctx,
        skills_context=skills_context,
        code_spec_context=code_spec_context,
        recall_context=recall_context,
        qa_history=qa_history,
        force_ready=force_ready,
    )
    result = await llm.chat(
        [
            {"role": "system", "content": "你是资深代码规划助手。只输出严格 JSON，不要输出 markdown 或解释。"},
            {"role": "user", "content": prompt},
        ],
        {"temperature": 0.1, "maxTokens": 2000},
        {"agent": "plan:loop"},
    )
    return _parse_output(result["text"], force_ready=force_ready)
