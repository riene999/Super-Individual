from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from orchestrator.llm.doubao import LLMClient
from orchestrator.repo.conduit import ConduitRepo
from orchestrator.types import ChangeSet, ClarifiedRequest, FileChange, FilePatch, FileStep, RepoContext, SkillPlan


ReferenceProvider = Callable[[FileStep, RepoContext], str | None]
BuildSteps = Callable[[ClarifiedRequest, RepoContext], list[FileStep]]


class LocateError(Exception):
    def __init__(self, reason: str, path: str, skill_name: str):
        super().__init__(f"[{skill_name}] {reason}: {path}")
        self.reason = reason
        self.path = path
        self.skill_name = skill_name


@dataclass
class Skill:
    name: str
    description: str
    match_words: list[str]
    build_steps: BuildSteps
    match_threshold: int = 4
    required_words: list[str] = field(default_factory=list)
    possible_aspects: list[str] = field(default_factory=list)
    aspect_question_template: dict[str, dict[str, str]] = field(default_factory=dict)
    reference_for: ReferenceProvider | None = None
    custom_match: Callable[[ClarifiedRequest, float], float] | None = None

    def match(self, req: ClarifiedRequest) -> float:
        score = keyword_match(req, self.match_words, self.match_threshold, self.required_words)
        return self.custom_match(req, score) if self.custom_match else score

    async def plan(self, req: ClarifiedRequest, ctx: RepoContext) -> SkillPlan:
        return SkillPlan(skillName=self.name, files=self.build_steps(req, ctx))

    async def locate(self, plan: SkillPlan, ctx: RepoContext) -> ChangeSet:
        return await default_locate(plan, ctx, self.reference_for)

    async def generate(self, changes: ChangeSet, llm: LLMClient) -> list[FilePatch]:
        return await default_generate(changes, llm)


def keyword_match(req: ClarifiedRequest, words: list[str], threshold: int, required_words: list[str] | None = None) -> float:
    haystack = " ".join([req.summary, req.fieldName, req.businessRule, req.displayLocation]).lower()
    if required_words and not any(w.lower() in haystack for w in required_words):
        return 0.0
    hits = sum(1 for w in words if w.lower() in haystack)
    return min(hits / threshold, 1.0)


async def default_locate(
    plan: SkillPlan,
    ctx: RepoContext,
    reference_for: ReferenceProvider | None = None,
) -> ChangeSet:
    repo = ConduitRepo(Path(ctx.repoPath))
    files: list[FileChange] = []
    context: dict[str, str] = {}
    references: dict[str, dict[str, str]] = {}
    for step in plan.files:
        current = repo.read_file_or_none(step.path)
        if step.mode == "modify":
            if current is None:
                raise LocateError("missing_modify_target", step.path, plan.skillName)
            context[step.path] = current
        else:
            if current is not None:
                raise LocateError("create_target_exists", step.path, plan.skillName)
            context[step.path] = ""
            if reference_for:
                ref_path = reference_for(step, ctx)
                ref_content = repo.read_file_or_none(ref_path) if ref_path else None
                if ref_path and ref_content:
                    references[step.path] = {"path": ref_path, "content": ref_content}
        files.append(FileChange(path=step.path, reason=step.instruction))
    return ChangeSet(
        files=files,
        context=context,
        meta={
            "skillName": plan.skillName,
            "steps": plan.files,
            "references": references,
            "contract": getattr(plan, "contract", ""),
            "symbolMap": getattr(ctx, "codeSpecSymbolMap", "") or "",
        },
    )


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else stripped
        if stripped.endswith("```"):
            stripped = stripped[:-3]
    return stripped.strip()


async def run_llm_on_file(
    llm: LLMClient,
    path: str,
    current_content: str,
    mode: str,
    instruction: str,
    reference: dict[str, str] | None,
    meta: dict[str, int | str],
) -> FilePatch:
    attempt = int(meta.get("attempt", 1))
    verify_error = str(meta.get("verifyError", "")).strip()
    verify_stdout = str(meta.get("verifyStdout", "")).strip()
    contract = str(meta.get("contract", "")).strip()
    plan_files = str(meta.get("planFiles", "")).strip()
    symbol_map = str(meta.get("symbolMap", "")).strip()

    shared_block = ""
    if plan_files or contract or symbol_map:
        shared_block = "本次需求会改动以下多个文件，你只负责其中当前这一个，但必须与其它文件保持一致：\n"
        if plan_files:
            shared_block += f"{plan_files}\n"
        if contract:
            shared_block += (
                "\n以下是跨文件必须严格共用的接口约定（组件名/默认导出名/import 路径/接口地址/字段名与枚举取值等），"
                "务必原样使用，绝对不要自行改名或换路径：\n"
                f"{contract}\n"
            )
        if symbol_map:
            shared_block += (
                "\n仓库相关文件的真实导出符号与 import 写法（grounding，务必据此使用正确的模块路径/导出名，"
                "不要臆造；需要 import 的东西照抄这里的真实写法，注意相对路径相对各文件自身位置）：\n"
                f"{symbol_map}\n"
            )
        shared_block += "\n----\n\n"

    if mode == "modify":
        body = f"""文件路径：{path}

当前内容{"（上一次生成的版本，验证未通过）" if verify_error or verify_stdout else ""}：
{current_content}

修改任务：
{instruction}"""
        tail = "返回完整的修改后文件内容："
    else:
        ref_block = ""
        if reference:
            ref_block = f"\n参考样例文件（{reference['path']}）：\n{reference['content']}\n"
        prev_block = ""
        if (verify_error or verify_stdout) and current_content.strip():
            prev_block = f"\n上一次生成的内容（验证未通过，在此基础上修复）：\n{current_content}\n"
        body = f"""从空白新建文件：{path}
{ref_block}创建任务：
{instruction}
{prev_block}"""
        tail = "返回该文件的完整内容："

    error_block = ""
    if verify_error or verify_stdout:
        error_block = f"""

上一次生成的代码验证未通过（这是第 {attempt} 次尝试）。请仔细阅读下面的验证报错，针对性修复后确保本次通过；只改必要之处，不要重写无关逻辑，也不要引入未使用依赖：
[stderr]
{verify_error or "(空)"}
[stdout]
{verify_stdout or "(空)"}"""

    user = f"{shared_block}{body}{error_block}\n\n{tail}"
    result = await llm.chat(
        [
            {"role": "system", "content": "你是专业代码助手。只返回完整文件内容，不加 markdown，不加解释。保持项目风格，不引入未使用依赖。"},
            {"role": "user", "content": user},
        ],
        {"temperature": 0.1, "maxTokens": 4096},
        {"agent": meta["agent"], "attempt": attempt},
    )
    return FilePatch(path=path, newContent=_strip_code_fence(result["text"]))


async def default_generate(changes: ChangeSet, llm: LLMClient) -> list[FilePatch]:
    steps = changes.meta.get("steps", [])
    refs = changes.meta.get("references", {})
    skill_name = str(changes.meta.get("skillName", "unknown"))
    attempt = int(changes.meta.get("attempt", 1))
    verify_error = str(changes.meta.get("verifyError", ""))
    verify_stdout = str(changes.meta.get("verifyStdout", ""))
    contract = str(changes.meta.get("contract", ""))
    symbol_map = str(changes.meta.get("symbolMap", ""))

    # 把整张文件清单渲染给每个文件生成调用，让各文件互相“看得见”，避免命名/接口漂移
    normalized_steps = [s if isinstance(s, FileStep) else FileStep(**s) for s in steps]
    plan_files = "\n".join(f"- [{s.mode}] {s.path}：{s.instruction}" for s in normalized_steps)

    patches: list[FilePatch] = []
    for idx, fc in enumerate(changes.files):
        if idx >= len(normalized_steps):
            continue
        step = normalized_steps[idx]
        patch = await run_llm_on_file(
            llm,
            fc.path,
            changes.context.get(fc.path, ""),
            step.mode,
            step.instruction,
            refs.get(fc.path),
            {
                "agent": f"code:{skill_name}",
                "attempt": attempt,
                "verifyError": verify_error,
                "verifyStdout": verify_stdout,
                "contract": contract,
                "planFiles": plan_files,
                "symbolMap": symbol_map,
            },
        )
        patches.append(patch)
    return patches
