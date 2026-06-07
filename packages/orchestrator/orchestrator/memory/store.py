from __future__ import annotations

import json
import os
from pathlib import Path

from orchestrator.events.store import read_events
from orchestrator.llm.doubao import LLMClient
from orchestrator.memory.extract import extract_entities
from orchestrator.types import ClarificationQA, ExtractedEntities, RequestMemory

ROOT = Path(__file__).resolve().parents[4]
MEMORY_DIR = Path(os.getenv("MEMORY_DIR", str(ROOT / "memory")))
MEMORY_FILE = "store.jsonl"


def _file() -> Path:
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    return MEMORY_DIR / MEMORY_FILE


def _entities_from_dict(data: dict) -> ExtractedEntities:
    return ExtractedEntities(
        domainObjects=data.get("domainObjects", []),
        operations=data.get("operations", []),
        affectedLayers=data.get("affectedLayers", []),
        fieldsAdded=data.get("fieldsAdded", []),
        uiSurfaces=data.get("uiSurfaces", []),
    )


def _memory_from_dict(data: dict) -> RequestMemory:
    return RequestMemory(
        runId=data["runId"],
        ts=data["ts"],
        summary=data["summary"],
        skillUsed=data.get("skillUsed"),
        mode=data.get("mode", "skill"),
        genericPlanFiles=data.get("genericPlanFiles"),
        entities=_entities_from_dict(data.get("entities", {})),
        changedFiles=data.get("changedFiles", []),
        clarifications=[ClarificationQA(**c) for c in data.get("clarifications", [])],
        outcome=data.get("outcome", "failed"),
        repoNwo=data.get("repoNwo"),
    )


def read_all_memories() -> list[RequestMemory]:
    path = _file()
    if not path.exists():
        return []
    out: list[RequestMemory] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            out.append(_memory_from_dict(json.loads(line)))
        except Exception:
            pass
    return out


def upsert_memory(mem: RequestMemory) -> None:
    all_mem = [m for m in read_all_memories() if m.runId != mem.runId]
    all_mem.append(mem)
    lines = []
    for m in all_mem:
        data = {
            **m.__dict__,
            "entities": m.entities.__dict__,
            "clarifications": [c.__dict__ for c in m.clarifications],
        }
        lines.append(json.dumps(data, ensure_ascii=False))
    _file().write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_partial_from_events(run_id: str) -> dict | None:
    events = read_events(run_id)
    if not events:
        return None
    clarify_done = next((e for e in events if e.type == "clarify.done"), None)
    req = (clarify_done.payload.get("req") if clarify_done else {}) or {}
    summary = str(req.get("summary", "(no summary)"))
    answers = req.get("answers") or {}
    clarify_questions = next((e for e in events if e.type == "clarify.questions"), None)
    raw_qs = (clarify_questions.payload.get("questions") if clarify_questions else []) or []
    aspect_map: dict[str, str] = {}
    for q in raw_qs:
        if isinstance(q, str):
            aspect_map[q] = "other"
        elif isinstance(q, dict) and q.get("q"):
            aspect_map[str(q["q"])] = str(q.get("aspect", "other"))
    clarifications = [ClarificationQA(q=q, a=a, aspect=aspect_map.get(q, "other")) for q, a in answers.items()]
    plan_done = next((e for e in events if e.type == "plan.done"), None)
    plan_generic = next((e for e in events if e.type == "plan.generic"), None)
    mode = "generic" if plan_generic else "skill"
    skill_used = None if plan_generic else (str(plan_done.payload.get("skillName", "")) if plan_done else "")
    if mode == "skill" and not skill_used:
        return None
    generic_plan_files = [str(f.get("path", "")) for f in (plan_generic.payload.get("files", []) if plan_generic else []) if f.get("path")]
    code_done = next((e for e in events if e.type == "code.done"), None)
    locate_done = next((e for e in events if e.type == "locate.done"), None)
    changed_files = code_done.payload.get("files", []) if code_done else []
    if not changed_files and locate_done:
        changed_files = [f.get("path") for f in locate_done.payload.get("files", []) if f.get("path")]
    completed = any(e.type == "run.completed" for e in events)
    verified = any(e.type == "verify.done" for e in events)
    return {
        "runId": run_id,
        "ts": events[0].ts,
        "summary": summary,
        "mode": mode,
        "skillUsed": skill_used,
        "genericPlanFiles": generic_plan_files or None,
        "changedFiles": changed_files,
        "clarifications": clarifications,
        "outcome": "verified" if completed and verified else "failed",
    }


async def persist_memory(run_id: str, llm: LLMClient, repo_nwo: str | None = None) -> RequestMemory | None:
    partial = build_partial_from_events(run_id)
    if not partial:
        return None
    entities = await extract_entities(
        llm,
        run_id=run_id,
        summary=partial["summary"],
        skill_used=partial["skillUsed"],
        changed_files=partial["changedFiles"],
        clarifications=partial["clarifications"],
    )
    mem = RequestMemory(**partial, entities=entities, repoNwo=repo_nwo)
    upsert_memory(mem)
    return mem

