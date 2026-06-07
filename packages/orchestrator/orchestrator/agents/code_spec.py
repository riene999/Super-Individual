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
from orchestrator.types import ClarifiedRequest

MAX_CONTENT_CHARS = 12_000
MAX_RELEVANT_FILES = 28
SUMMARY_CONCURRENCY = 8


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


async def summarize_file(repo: ConduitRepo, relative_path: str, llm: LLMClient, run_id: str | None = None) -> dict[str, Any]:
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
{{"summary":"一句话说明这个文件的主要逻辑和职责，80字以内","tags":["少量关键词"],"symbols":["主要函数/类/组件/导出名"]}}

要求：
- summary 必须说明业务/技术职责，不要泛泛说“这个文件包含代码”。
- tags 使用小写英文或常见中文词，最多 8 个。
- symbols 最多 8 个。""",
                },
            ],
            {"temperature": 0.1, "maxTokens": 500},
            {"agent": "code-spec:summarize", "runId": run_id or "_global"},
        )
        data = _clean_json(result["text"])
        return {
            "summary": str(data.get("summary") or fallback["summary"])[:300],
            "tags": [str(x)[:40] for x in (data.get("tags") or fallback["tags"])[:12]],
            "symbols": [str(x)[:80] for x in (data.get("symbols") or fallback["symbols"])[:12]],
            "imports": fallback.get("imports", []),
        }
    except Exception:
        return fallback


def _entry(repo: ConduitRepo, relative_path: str, summary: dict[str, Any]) -> dict[str, Any]:
    path = repo.repo_path / relative_path
    return {
        "path": relative_path,
        "hash": spec_store.file_hash(path),
        "bytes": path.stat().st_size,
        "summary": summary.get("summary", ""),
        "tags": summary.get("tags", []),
        "symbols": summary.get("symbols", []),
        "imports": summary.get("imports", []),
        "updatedAt": int(time.time() * 1000),
    }


async def ensure_current(repo: ConduitRepo, llm: LLMClient, run_id: str | None = None) -> dict[str, Any]:
    current = spec_store.read_spec(repo.upstream_nwo, repo.repo_path, "current")
    if current is None:
        current = spec_store.empty_spec(repo.upstream_nwo, repo.repo_path, repo.get_context().branch)

    files = spec_store.list_indexable_files(repo.repo_path)
    current_files = current.setdefault("files", {})
    changed: list[str] = []
    for relative_path in files:
        absolute_path = repo.repo_path / relative_path
        h = spec_store.file_hash(absolute_path)
        if current_files.get(relative_path, {}).get("hash") != h:
            changed.append(relative_path)

    removed = [path for path in list(current_files.keys()) if path not in set(files)]
    for path in removed:
        current_files.pop(path, None)

    sem = asyncio.Semaphore(SUMMARY_CONCURRENCY)

    async def _summarize(relative_path: str) -> tuple[str, dict[str, Any]]:
        async with sem:
            summary = await summarize_file(repo, relative_path, llm, run_id)
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


def relevant_entries(req: ClarifiedRequest, repo: ConduitRepo, limit: int = MAX_RELEVANT_FILES) -> list[dict[str, Any]]:
    spec = spec_store.read_spec(repo.upstream_nwo, repo.repo_path, "current")
    if not spec:
        return []
    query = " ".join([req.summary, req.fieldName, req.fieldType, req.displayLocation, req.businessRule])
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


def format_relevant_context(req: ClarifiedRequest, repo: ConduitRepo, limit: int = MAX_RELEVANT_FILES) -> str:
    entries = relevant_entries(req, repo, limit)
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
