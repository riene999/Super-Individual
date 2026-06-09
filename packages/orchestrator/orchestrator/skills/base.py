from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from orchestrator.llm.doubao import LLMClient
from orchestrator.repo.conduit import ConduitRepo
from orchestrator.types import ChangeSet, FileChange, FilePatch, FileStep, RepoContext, SkillPlan


ReferenceProvider = Callable[[FileStep, RepoContext], str | None]


class LocateError(Exception):
    def __init__(self, reason: str, path: str, skill_name: str):
        super().__init__(f"[{skill_name}] {reason}: {path}")
        self.reason = reason
        self.path = path
        self.skill_name = skill_name


@dataclass
class Skill:
    """locate/generate 的执行载体；规划与澄清由 plan_loop 负责，这里不再做关键词匹配或静态步骤生成。"""

    name: str
    description: str
    reference_for: ReferenceProvider | None = None

    async def locate(self, plan: SkillPlan, ctx: RepoContext) -> ChangeSet:
        return await default_locate(plan, ctx, self.reference_for)

    async def generate(self, changes: ChangeSet, llm: LLMClient, repo: "ConduitRepo | None" = None) -> list[FilePatch]:
        return await default_generate(changes, llm, repo)


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


def _build_shared_block(meta: dict[str, int | str]) -> str:
    """跨文件共享上下文：文件清单 + 接口契约 + 选中文件的符号地图。"""
    contract = str(meta.get("contract", "")).strip()
    plan_files = str(meta.get("planFiles", "")).strip()
    symbol_map = str(meta.get("symbolMap", "")).strip()
    if not (plan_files or contract or symbol_map):
        return ""
    block = "本次需求会改动以下多个文件，你只负责其中当前这一个，但必须与其它文件保持一致：\n"
    if plan_files:
        block += f"{plan_files}\n"
    if contract:
        block += (
            "\n以下是跨文件必须严格共用的接口约定（组件名/默认导出名/import 路径/接口地址/字段名与枚举取值等），"
            "务必原样使用，绝对不要自行改名或换路径：\n"
            f"{contract}\n"
        )
    if symbol_map:
        block += (
            "\n仓库相关文件的真实导出符号与 import 写法（grounding，务必据此使用正确的模块路径/导出名，"
            "不要臆造；需要 import 的东西照抄这里的真实写法，注意相对路径相对各文件自身位置）：\n"
            f"{symbol_map}\n"
        )
    return block + "\n----\n\n"


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
    shared_block = _build_shared_block(meta)

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


TOOL_MAX_STEPS = 3
_GREP_MAX = 30
_READ_MAX_LINES = 200
_READ_MAX_CHARS = 6000
_LIST_MAX = 100

_TOOL_NAMES = {"grep", "read_file", "list_files"}

_TOOL_PROTOCOL = """
你可以先用只读工具查证仓库的真实写法。需要查时，**本轮只输出一个 JSON**（不要加解释或 markdown），三选一：
{"action":"grep","pattern":"正则或子串","glob":"可选，如 backend/**/*.js"}
{"action":"read_file","path":"相对路径","start":1,"end":120}
{"action":"list_files","glob":"如 backend/middleware/*.js"}

硬性要求：在使用任何**项目内部**的导入（hook / context / 组件 / service / helper / 模型）之前，必须先用 read_file 或 grep 确认它的真实导出名、调用签名（入参与返回结构）与用法，不得凭记忆假设；只有第三方库（node_modules 里的）可凭通识直接用。上面若已给出该符号的接口签名，可据此使用、无需再查。

查清楚后（或确实无需查时），**直接输出该文件的完整内容本身**——纯代码，不要再输出 JSON、不要解释、不要用 markdown 代码块包裹。
"""


def _tool_grep(repo: "ConduitRepo", args: dict) -> str:
    pattern = str(args.get("pattern", "")).strip()
    glob = str(args.get("glob") or "**/*")
    if not pattern:
        return "grep 需要 pattern"
    try:
        matches = repo.grep(pattern, glob)
    except Exception as e:
        return f"grep 出错：{e}"
    if not matches:
        return "无匹配"
    out = [f"{m.path}:{m.line}: {m.content}"[:200] for m in matches[:_GREP_MAX]]
    if len(matches) > _GREP_MAX:
        out.append(f"…(共 {len(matches)} 条，已截断)")
    return "\n".join(out)


def _tool_read(repo: "ConduitRepo", args: dict) -> str:
    path = str(args.get("path", "")).strip()
    if not path:
        return "read_file 需要 path"
    content = repo.read_file_or_none(path)
    if content is None:
        return f"文件不存在：{path}"
    lines = content.splitlines()
    start = max(1, int(args.get("start") or 1))
    end = int(args.get("end") or (start + _READ_MAX_LINES - 1))
    end = min(end, len(lines), start + _READ_MAX_LINES - 1)
    sel = lines[start - 1:end]
    body = "\n".join(f"{start + i}: {ln}" for i, ln in enumerate(sel))
    return body[:_READ_MAX_CHARS] or "(空文件)"


def _tool_list(repo: "ConduitRepo", args: dict) -> str:
    glob = str(args.get("glob", "")).strip()
    if not glob:
        return "list_files 需要 glob"
    files = repo.list_files(glob)[:_LIST_MAX]
    return "\n".join(files) or "无匹配文件"


def _run_tool_cached(repo: "ConduitRepo", act: dict, cache: dict[str, str]) -> str:
    key = json.dumps(act, sort_keys=True, ensure_ascii=False)
    if key in cache:
        return cache[key]
    action = str(act.get("action", ""))
    if action == "grep":
        obs = _tool_grep(repo, act)
    elif action == "read_file":
        obs = _tool_read(repo, act)
    elif action == "list_files":
        obs = _tool_list(repo, act)
    else:
        obs = f"未知工具：{action}（可用：grep/read_file/list_files/write_file）"
    cache[key] = obs
    return obs


def _parse_action(text: str) -> dict | None:
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.endswith("```"):
            s = s[:-3]
    s = s.strip()
    try:
        data = json.loads(s)
    except Exception:
        start = s.find("{")
        end = s.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            data = json.loads(s[start:end + 1])
        except Exception:
            return None
    return data if isinstance(data, dict) else None


async def run_llm_on_file_with_tools(
    llm: LLMClient,
    repo: "ConduitRepo",
    path: str,
    current_content: str,
    instruction: str,
    reference: dict[str, str] | None,
    meta: dict[str, int | str],
    cache: dict[str, str],
) -> FilePatch:
    """带只读工具的有界生成循环：模型按需 grep/read_file/list_files 查证，查清后直接输出文件原文。"""
    attempt = int(meta.get("attempt", 1))
    verify_error = str(meta.get("verifyError", "")).strip()
    verify_stdout = str(meta.get("verifyStdout", "")).strip()
    shared_block = _build_shared_block(meta)

    ref_block = f"\n参考样例文件（{reference['path']}）：\n{reference['content']}\n" if reference else ""
    prev_block = ""
    if (verify_error or verify_stdout) and current_content.strip():
        prev_block = f"\n上一次生成的内容（验证未通过，在此基础上修复）：\n{current_content}\n"
    error_block = ""
    if verify_error or verify_stdout:
        error_block = (
            f"\n\n上一次验证未通过（第 {attempt} 次尝试），请针对性修复：\n"
            f"[stderr]\n{verify_error or '(空)'}\n[stdout]\n{verify_stdout or '(空)'}"
        )

    task = f"""你要新建文件：{path}
{ref_block}创建任务：
{instruction}
{prev_block}{error_block}"""

    messages = [
        {
            "role": "system",
            "content": "你是专业代码助手。可用只读工具查证仓库的真实写法，避免臆造模块路径/导出名。保持项目风格，不引入未声明依赖。",
        },
        {"role": "user", "content": f"{shared_block}{task}\n{_TOOL_PROTOCOL}"},
    ]

    for _ in range(TOOL_MAX_STEPS):
        result = await llm.chat(messages, {"temperature": 0.1, "maxTokens": 4096}, {"agent": meta["agent"], "attempt": attempt})
        text = result["text"]
        act = _parse_action(text)
        # 只有"明确是工具调用的小 JSON"才当工具；其余一律视为最终文件原文（绝不把模型输出再当 JSON 解出代码）
        if act is not None and str(act.get("action", "")) in _TOOL_NAMES:
            obs = _run_tool_cached(repo, act, cache)
            messages.append({"role": "assistant", "content": text})
            messages.append({"role": "user", "content": f"工具结果：\n{obs}"})
            continue
        return FilePatch(path=path, newContent=_strip_code_fence(text))

    # 步数用尽：让它别再查，直接交文件原文
    messages.append({"role": "user", "content": "不要再调用工具，现在直接输出该文件的完整内容本身（纯代码，不要 JSON、不要解释）。"})
    result = await llm.chat(messages, {"temperature": 0.1, "maxTokens": 4096}, {"agent": meta["agent"], "attempt": attempt})
    return FilePatch(path=path, newContent=_strip_code_fence(result["text"]))


async def default_generate(changes: ChangeSet, llm: LLMClient, repo: "ConduitRepo | None" = None) -> list[FilePatch]:
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
    tool_cache: dict[str, str] = {}  # 同一次生成内复用工具结果（如同一个 import 路径只查一次）
    for idx, fc in enumerate(changes.files):
        if idx >= len(normalized_steps):
            continue
        step = normalized_steps[idx]
        file_meta = {
            "agent": f"code:{skill_name}",
            "attempt": attempt,
            "verifyError": verify_error,
            "verifyStdout": verify_stdout,
            "contract": contract,
            "planFiles": plan_files,
            "symbolMap": symbol_map,
        }
        # 新建文件最需要 grounding：给它装只读工具，按需查证真实写法后再生成
        if repo is not None and step.mode == "create":
            patch = await run_llm_on_file_with_tools(
                llm, repo, fc.path, changes.context.get(fc.path, ""),
                step.instruction, refs.get(fc.path), file_meta, tool_cache,
            )
        else:
            patch = await run_llm_on_file(
                llm, fc.path, changes.context.get(fc.path, ""),
                step.mode, step.instruction, refs.get(fc.path), file_meta,
            )
        patches.append(patch)
    return patches
