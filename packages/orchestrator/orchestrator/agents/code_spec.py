from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import Any

from orchestrator.llm.doubao import LLMClient
from orchestrator.repo import spec_store
from orchestrator.repo.conduit import ConduitRepo

MAX_CONTENT_CHARS = 12_000
MAX_RELEVANT_FILES = 28
SUMMARY_CONCURRENCY = 8
SELECT_MAX = 30           # code-spec 选择 agent 最多挑多少个文件
CATALOG_MAX_FILES = 350   # 索引超过此数则跳过 LLM 选片，回退关键词（避免 token 爆）


def _clean_json(text: str) -> dict[str, Any]:
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.endswith("```"):
            s = s[:-3]
    try:
        return json.loads(s.strip())
    except Exception:
        start = s.find("{")
        end = s.rfind("}")
        if start >= 0 and end > start:
            return json.loads(s[start : end + 1])
        raise


def _safe_read(repo: ConduitRepo, relative_path: str) -> str:
    path = repo.repo_path / relative_path
    return path.read_text(encoding="utf-8", errors="ignore")[:MAX_CONTENT_CHARS]


async def summarize_file(repo: ConduitRepo, relative_path: str, llm: LLMClient, run_id: str | None = None) -> dict[str, Any] | None:
    content = _safe_read(repo, relative_path)
    fallback = spec_store.local_file_summary(relative_path, content)
    try:
        result = await llm.chat(
            [
                {
                    "role": "system",
                    "content": (
                        "你是代码仓库摘要助手。请为单个文件生成简短、事实化的代码规范摘要。"
                        "只输出 JSON，不输出 markdown。"
                    ),
                },
                {
                    "role": "user",
                    "content": f"""文件路径：{relative_path}

文件内容：
{content}

请输出 JSON：
{{"summary":"一句话说明这个文件的主要逻辑和职责，80字以内","tags":["少量关键词"],"symbols":["主要函数/类/组件/导出名"],"interfaces":["每个对外导出的完整签名：入参与返回/形状"]}}

要求：
- summary 必须说明业务/技术职责，不要泛泛说“这个文件包含代码”。
- tags 使用小写英文或常见中文词，最多 8 个。
- symbols 最多 8 个。
- interfaces：对每个对外导出，写清它的调用签名（入参顺序与含义）和返回/产出结构，例如：
  · 函数/service：toggleCommentLike(slug, commentId, isLiked) -> comment
  · hook：useAuth() -> 返回对象，字段 headers/isAuth/loggedUser
  · React 组件：CommentList(props: comments、slug) -> JSX
  · 模型：modelName=Comment, table=Comments, fields=[id, body, likeCount]
  最多 8 条；据实抽取，不要臆造。""",
                },
            ],
            {"temperature": 0.1, "maxTokens": 800},
            {"agent": "code-spec:summarize", "runId": run_id or "_global"},
        )
        data = _clean_json(result["text"])
        return {
            "summary": str(data.get("summary") or fallback["summary"])[:300],
            "tags": [str(x)[:40] for x in (data.get("tags") or fallback["tags"])[:12]],
            "symbols": [str(x)[:80] for x in (data.get("symbols") or fallback["symbols"])[:12]],
            "interfaces": [str(x)[:200] for x in (data.get("interfaces") or [])[:8]],
            "imports": fallback.get("imports", []),
        }
    except Exception:
        return None  # 摘要失败（网络/解析等）：返回 None 让调用方保留旧条目，不要用空摘要覆盖好数据


def _entry(repo: ConduitRepo, relative_path: str, summary: dict[str, Any]) -> dict[str, Any]:
    path = repo.repo_path / relative_path
    return {
        "path": relative_path,
        "hash": spec_store.file_hash(path),
        "bytes": path.stat().st_size,
        "summary": summary.get("summary", ""),
        "tags": summary.get("tags", []),
        "symbols": summary.get("symbols", []),
        "interfaces": summary.get("interfaces", []),
        "imports": summary.get("imports", []),
        "updatedAt": int(time.time() * 1000),
    }


async def ensure_current(repo: ConduitRepo, llm: LLMClient, run_id: str | None = None, rebuild: bool = False) -> dict[str, Any]:
    current = spec_store.read_spec(repo.upstream_nwo, repo.repo_path, "current")
    if current is None:
        current = spec_store.empty_spec(repo.upstream_nwo, repo.repo_path, repo.get_context().branch)

    files = spec_store.list_indexable_files(repo.repo_path)
    current_files = current.setdefault("files", {})
    changed: list[str] = []
    for relative_path in files:
        absolute_path = repo.repo_path / relative_path
        h = spec_store.file_hash(absolute_path)
        entry = current_files.get(relative_path, {})
        # rebuild=全量重摘要；否则 hash 变了重摘要，老条目缺 interfaces 字段（旧 schema）也重摘要一次做迁移
        if rebuild or entry.get("hash") != h or "interfaces" not in entry:
            changed.append(relative_path)

    removed = [path for path in list(current_files.keys()) if path not in set(files)]
    for path in removed:
        current_files.pop(path, None)

    sem = asyncio.Semaphore(SUMMARY_CONCURRENCY)

    async def _summarize(relative_path: str) -> tuple[str, dict[str, Any]]:
        async with sem:
            summary = await summarize_file(repo, relative_path, llm, run_id)
        if summary is None:
            # 摘要失败：优先保留旧条目（别用空摘要覆盖好数据），没有旧的才用本地兜底
            old = current_files.get(relative_path)
            if old:
                return relative_path, old
            summary = spec_store.local_file_summary(relative_path, _safe_read(repo, relative_path))
        return relative_path, _entry(repo, relative_path, summary)

    for relative_path, entry in await asyncio.gather(*(_summarize(p) for p in changed)):
        current_files[relative_path] = entry

    current["updatedAt"] = int(time.time() * 1000)
    current["branch"] = repo.get_context().branch
    spec_store.write_spec(repo.upstream_nwo, repo.repo_path, "current", current)

    initial = spec_store.read_spec(repo.upstream_nwo, repo.repo_path, "initial")
    if initial is None:
        spec_store.write_spec(repo.upstream_nwo, repo.repo_path, "initial", current)

    return {
        "status": "ready",
        "fileCount": len(current_files),
        "changedCount": len(changed),
        "removedCount": len(removed),
        "initialCreated": initial is None,
    }


async def update_files(repo: ConduitRepo, llm: LLMClient, paths: list[str], run_id: str | None = None) -> dict[str, Any]:
    current = spec_store.read_spec(repo.upstream_nwo, repo.repo_path, "current")
    if current is None:
        return await ensure_current(repo, llm, run_id)

    current_files = current.setdefault("files", {})
    removed = 0
    to_summarize: list[str] = []
    for relative_path in sorted(set(paths)):
        normalized = relative_path.replace("\\", "/")
        absolute_path = repo.repo_path / normalized
        if not absolute_path.exists():
            if current_files.pop(normalized, None) is not None:
                removed += 1
            continue
        if not spec_store.should_index(normalized, absolute_path):
            continue
        to_summarize.append(normalized)

    sem = asyncio.Semaphore(SUMMARY_CONCURRENCY)

    async def _summarize(normalized: str) -> tuple[str, dict[str, Any]]:
        async with sem:
            summary = await summarize_file(repo, normalized, llm, run_id)
        if summary is None:
            old = current_files.get(normalized)
            if old:
                return normalized, old
            summary = spec_store.local_file_summary(normalized, _safe_read(repo, normalized))
        return normalized, _entry(repo, normalized, summary)

    for normalized, entry in await asyncio.gather(*(_summarize(p) for p in to_summarize)):
        current_files[normalized] = entry
    updated = len(to_summarize)

    current["updatedAt"] = int(time.time() * 1000)
    current["branch"] = repo.get_context().branch
    spec_store.write_spec(repo.upstream_nwo, repo.repo_path, "current", current)
    return {"status": "updated", "updatedCount": updated, "removedCount": removed, "fileCount": len(current_files)}


def _tokens(text: str) -> set[str]:
    lowered = text.lower()
    ascii_tokens = set(re.findall(r"[a-zA-Z][a-zA-Z0-9_]{1,}", lowered))
    chinese_chunks = set(re.findall(r"[\u4e00-\u9fff]{2,}", text))
    return ascii_tokens | chinese_chunks


def relevant_entries(query: str, repo: ConduitRepo, limit: int = MAX_RELEVANT_FILES) -> list[dict[str, Any]]:
    spec = spec_store.read_spec(repo.upstream_nwo, repo.repo_path, "current")
    if not spec:
        return []
    query_tokens = _tokens(query)
    scored: list[tuple[int, dict[str, Any]]] = []
    for entry in (spec.get("files") or {}).values():
        haystack = " ".join(
            [
                str(entry.get("path", "")),
                str(entry.get("summary", "")),
                " ".join(str(x) for x in entry.get("tags", [])),
                " ".join(str(x) for x in entry.get("symbols", [])),
            ]
        ).lower()
        score = 0
        for token in query_tokens:
            if token.lower() in haystack:
                score += 3 if token.lower() in str(entry.get("path", "")).lower() else 1
        if score:
            scored.append((score, entry))
    scored.sort(key=lambda item: (-item[0], item[1].get("path", "")))
    return [entry for _, entry in scored[:limit]]


def symbol_map_for(repo: ConduitRepo, paths: list[str]) -> str:
    """为给定文件生成“符号地图”：path + 导出/符号 + 真实 import 写法（来自 code-spec 索引）。

    供生成阶段 grounding：让代码 agent 看到真实的导出名与既有 import 写法，避免臆造模块路径。
    """
    spec = spec_store.read_spec(repo.upstream_nwo, repo.repo_path, "current")
    files = (spec or {}).get("files") or {}
    lines: list[str] = []
    for p in paths:
        entry = files.get(p)
        if not entry:
            continue
        symbols = ", ".join(str(x) for x in (entry.get("symbols") or [])[:12])
        interfaces = entry.get("interfaces") or []
        imports = " ; ".join(str(x) for x in (entry.get("imports") or [])[:8])
        parts = [f"- {p}"]
        if symbols:
            parts.append(f"导出/符号: {symbols}")
        if interfaces:
            parts.append("接口签名(入参->返回):\n    " + "\n    ".join(str(x) for x in interfaces[:8]))
        if imports:
            parts.append(f"import 写法: {imports}")
        lines.append("\n  ".join(parts))
    return "\n".join(lines)


def _render_entries(entries: list[dict[str, Any]]) -> str:
    if not entries:
        return "代码规范索引暂未命中相关文件。"
    lines = []
    for entry in entries:
        tags = ", ".join(str(x) for x in entry.get("tags", [])[:6])
        symbols = ", ".join(str(x) for x in entry.get("symbols", [])[:6])
        lines.append(
            f"- {entry.get('path')}: {entry.get('summary')}"
            + (f" | tags: {tags}" if tags else "")
            + (f" | symbols: {symbols}" if symbols else "")
        )
    return "\n".join(lines)


def format_relevant_context(query: str, repo: ConduitRepo, limit: int = MAX_RELEVANT_FILES) -> str:
    """关键词 token 重叠召回（同步、无 LLM），作为 select_relevant_context 的 fallback。"""
    return _render_entries(relevant_entries(query, repo, limit))


async def select_relevant_context(
    query: str, repo: ConduitRepo, llm: LLMClient, run_id: str | None = None
) -> tuple[str, list[str]]:
    """code-spec 选择 agent：把全量索引目录交给 LLM，按语义挑出与需求相关的文件。

    返回 (渲染后的相关文件摘要文本, 选中的路径列表)。LLM 失败 / 索引过大 / 无命中时回退关键词召回。
    """
    spec = spec_store.read_spec(repo.upstream_nwo, repo.repo_path, "current")
    items = list(((spec or {}).get("files") or {}).values())
    if not items:
        return "代码规范索引暂未命中相关文件。", []

    def _keyword_fallback() -> tuple[str, list[str]]:
        entries = relevant_entries(query, repo)
        return _render_entries(entries), [str(e.get("path", "")) for e in entries]

    # 索引过大：直接走关键词，避免目录 token 爆
    if len(items) > CATALOG_MAX_FILES:
        return _keyword_fallback()

    catalog_lines = []
    for entry in items:
        tags = ", ".join(str(x) for x in (entry.get("tags") or [])[:6])
        summary = str(entry.get("summary", ""))[:120]
        catalog_lines.append(f"{entry.get('path')} — {summary}" + (f" | {tags}" if tags else ""))
    catalog = "\n".join(catalog_lines)

    try:
        result = await llm.chat(
            [
                {"role": "system", "content": "你是代码检索助手。从给定文件目录中挑出与需求实现最相关的文件。只输出 JSON，不要解释。"},
                {
                    "role": "user",
                    "content": f"""需求：{query}

仓库文件目录（每行：path — 摘要 | tags）：
{catalog}

请挑出实现该需求最相关的文件：既包括很可能需要改动的文件，也包括能体现相关约定/可参考范例的文件（同类已有功能、对应模型、路由注册文件、可参考组件等）。
- 最多 {SELECT_MAX} 个；宁缺毋滥，但不要漏掉明显涉及的层（model/controller/route/页面/组件）。
- 若需求涉及鉴权/会话、网络请求封装、错误处理、全局状态/上下文、共享配置等**横切关注点**，也要把对应的基础设施文件选上（新代码很可能要调用它们，需要知道其真实接口）。
- path 必须从上面目录里原样照抄，不要臆造。
输出 JSON：{{"paths":["...","..."]}}""",
                },
            ],
            {"temperature": 0.1, "maxTokens": 800},
            {"agent": "code-spec:select", "runId": run_id or "_global"},
        )
        data = _clean_json(result["text"])
        picked = [str(p).strip() for p in (data.get("paths") or [])]
    except Exception:
        return _keyword_fallback()

    by_path = {str(e.get("path")): e for e in items}
    seen: set[str] = set()
    chosen: list[dict[str, Any]] = []
    for p in picked:
        entry = by_path.get(p)
        if entry and p not in seen:
            seen.add(p)
            chosen.append(entry)
        if len(chosen) >= SELECT_MAX:
            break

    if not chosen:
        return _keyword_fallback()
    return _render_entries(chosen), [str(e.get("path")) for e in chosen]
