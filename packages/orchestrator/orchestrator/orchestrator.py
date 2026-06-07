from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from typing import Any
from uuid import uuid4

from orchestrator.agents import clarify, code, locate, plan as plan_agent, verify
from orchestrator.agents.aspect_scan import aspect_scan, filter_recall_for_scan
from orchestrator.agents.generic_plan import generic_plan, generic_skill
from orchestrator.events import store as event_store
from orchestrator.llm.doubao import create_doubao_client
from orchestrator.memory.extract import extract_entities
from orchestrator.memory.recall import recall
from orchestrator.memory.store import persist_memory, read_all_memories
from orchestrator.repo.conduit import create_conduit_repo
from orchestrator.skills.registry import load_skills
from orchestrator.types import ChangeSet, ClarifiedRequest, RunEvent, dataclass_to_json

MAX_VERIFY_RETRIES = 2


class EventBus:
    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue[RunEvent]]] = defaultdict(list)

    def emit(self, event: RunEvent) -> None:
        for q in list(self._subscribers.get(event.runId, [])):
            q.put_nowait(event)

    async def subscribe(self, run_id: str):
        q: asyncio.Queue[RunEvent] = asyncio.Queue()
        self._subscribers[run_id].append(q)
        try:
            yield q
        finally:
            self._subscribers[run_id].remove(q)


bus = EventBus()
pending_answers: dict[str, asyncio.Future[dict[str, str]]] = {}
run_phase: dict[str, str] = {}


def emit_and_broadcast(run_id: str, event_type: str, payload: dict[str, Any]) -> RunEvent:
    event = event_store.emit(run_id, event_type, payload)
    bus.emit(event)
    return event


def _req_payload(req: ClarifiedRequest) -> dict[str, Any]:
    return dataclass_to_json(req)


def _plan_payload_files(files) -> list[dict[str, Any]]:
    return [dataclass_to_json(f) for f in files]


async def start_run(raw_text: str) -> str:
    run_id = str(uuid4())
    llm = create_doubao_client({"runId": run_id})
    repo = create_conduit_repo()
    asyncio.create_task(_run_pipeline(run_id, raw_text, llm, repo))
    return run_id


def provide_clarification_answers(run_id: str, answers: dict[str, str]) -> bool:
    fut = pending_answers.pop(run_id, None)
    if not fut or fut.done():
        return False
    fut.set_result(answers)
    return True


async def _wait_for_answers(run_id: str) -> dict[str, str]:
    fut: asyncio.Future[dict[str, str]] = asyncio.get_running_loop().create_future()
    pending_answers[run_id] = fut
    return await fut


async def _run_pipeline(run_id: str, raw_text: str, llm, repo) -> None:
    try:
        emit_and_broadcast(run_id, "run.started", {"rawText": raw_text, "recallDisabled": False})
        run_phase[run_id] = "clarify"
        all_skills = await load_skills()
        aspect_union = list(dict.fromkeys(aspect for s in all_skills for aspect in s.possible_aspects))
        analysis_req = await clarify.analyze(raw_text, llm)

        recall_matches_for_scan: list[dict[str, Any]] = []
        try:
            query_entities = await extract_entities(llm, run_id=run_id, summary=analysis_req.summary, skill_used="")
            matches = recall(query_entities, read_all_memories(), top_k=3, min_score=0.3)
            if matches:
                payload = [
                    {
                        "runId": m.memory.runId,
                        "score": m.score,
                        "matchedDimensions": m.matchedDimensions,
                        "summary": m.memory.summary,
                        "skillUsed": m.memory.skillUsed,
                        "outcome": m.memory.outcome,
                        "expectedFiles": m.memory.changedFiles,
                        "clarifications": [c.__dict__ for c in m.memory.clarifications],
                    }
                    for m in matches
                ]
                emit_and_broadcast(run_id, "recall.matched", {"queryEntities": query_entities.__dict__, "matches": payload})
                recall_matches_for_scan = payload
        except Exception:
            pass

        run_phase[run_id] = "plan"
        ctx = repo.get_context()
        plan_result = await plan_agent.run(analysis_req, ctx, llm)
        if plan_result.mode == "generic":
            emit_and_broadcast(
                run_id,
                "plan.generic",
                {
                    "mode": "generic",
                    "plan": dataclass_to_json(plan_result.plan),
                    "files": _plan_payload_files(plan_result.plan.files),
                    "score": plan_result.score,
                    "by": plan_result.by,
                    "candidates": plan_result.candidates,
                    "routerReason": plan_result.routerReason,
                    "reason": plan_result.genericReason,
                },
            )
        else:
            emit_and_broadcast(
                run_id,
                "plan.done",
                {
                    "mode": "skill",
                    "plan": dataclass_to_json(plan_result.plan),
                    "skillName": plan_result.skill.name if plan_result.skill else "",
                    "score": plan_result.score,
                    "by": plan_result.by,
                    "candidates": plan_result.candidates,
                    "routerReason": plan_result.routerReason,
                },
            )

        skill = plan_result.skill or generic_skill
        scan_for_skill: list[dict[str, Any]] = []
        if plan_result.mode == "generic":
            run_phase[run_id] = "clarify:generic"
            questions = await clarify.generic_questions(raw_text, analysis_req, llm, run_id)
        else:
            run_phase[run_id] = "aspect-scan"
            scan_result = await aspect_scan(
                llm,
                run_id=run_id,
                raw_text=raw_text,
                candidate_aspects=aspect_union,
                recalled_history=filter_recall_for_scan(recall_matches_for_scan),
            )
            skill_aspects = set(skill.possible_aspects)
            scan_for_skill = [item for item in scan_result.items if item.aspect in skill_aspects]
            emit_and_broadcast(
                run_id,
                "aspect.scanned",
                {
                    "skillName": skill.name,
                    "all": [dataclass_to_json(item) for item in scan_result.items],
                    "forSkill": [dataclass_to_json(item) for item in scan_for_skill],
                    "breakdown": {
                        "explicit": len([s for s in scan_for_skill if s.status == "explicit"]),
                        "fromHistory": len([s for s in scan_for_skill if s.status == "from-history"]),
                        "needsAsking": len([s for s in scan_for_skill if s.status == "needs-asking"]),
                    },
                },
            )
            questions = await clarify.build_questions_from_aspects(scan_for_skill, skill, llm, run_id)

        emit_and_broadcast(
            run_id,
            "clarify.questions",
            {
                "questions": [q.__dict__ for q in questions],
                "partial": _req_payload(analysis_req),
                "aspectScan": [dataclass_to_json(item) for item in scan_for_skill],
                "mode": plan_result.mode,
            },
        )

        run_phase[run_id] = "clarify"
        if questions:
            answers = await _wait_for_answers(run_id)
            req = await clarify.resolve(raw_text, analysis_req, answers, llm)
        else:
            inferred_answers = {
                item.aspect: item.evidence
                for item in scan_for_skill
                if item.status in ("explicit", "from-history") and item.evidence
            }
            req = ClarifiedRequest(**{**analysis_req.__dict__, "answers": inferred_answers})
        emit_and_broadcast(run_id, "clarify.done", {"req": _req_payload(req)})

        final_plan = await generic_plan(req, ctx, llm) if plan_result.mode == "generic" else await skill.plan(req, ctx)
        run_phase[run_id] = "locate"
        changes = await locate.run(skill, final_plan, ctx)
        emit_and_broadcast(run_id, "locate.done", {"attempt": 1, "files": [f.__dict__ for f in changes.files], "fileCount": len(changes.files)})
        patches = await _run_code_and_verify(run_id, skill, changes, llm, repo)

        run_phase[run_id] = "commit"
        branch = f"feat/{req.fieldName}-{int(time.time() * 1000)}"
        repo.checkout_branch(branch)
        commit_msg = f"feat: add {req.fieldName} field\n\n{req.businessRule}"
        repo.stage_and_commit(commit_msg)
        emit_and_broadcast(
            run_id,
            "commit.done",
            {"branch": branch, "commitMessage": commit_msg, "prDescription": f"feat: add {req.fieldName}\n\n{req.businessRule}", "patchCount": len(patches)},
        )
        emit_and_broadcast(run_id, "run.completed", {"runId": run_id})
        run_phase.pop(run_id, None)
        try:
            await persist_memory(run_id, llm)
        except Exception:
            pass
    except Exception as e:
        emit_and_broadcast(run_id, "run.error", {"message": str(e)})
        run_phase.pop(run_id, None)


async def _run_code_and_verify(run_id: str, skill, changes: ChangeSet, llm, repo) -> list:
    attempt = 1
    while True:
        run_phase[run_id] = f"code:attempt{attempt}"
        changes.meta = {**changes.meta, "attempt": attempt}
        patches = await code.run(skill, changes, llm, repo)
        emit_and_broadcast(run_id, "code.done", {"attempt": attempt, "files": [p.path for p in patches]})
        run_phase[run_id] = f"verify:attempt{attempt}"
        emit_and_broadcast(run_id, "verify.running", {"attempt": attempt})
        result = await verify.run(repo, [p.path for p in patches])
        if result.success:
            emit_and_broadcast(run_id, "verify.done", {"attempt": attempt, **result.__dict__})
            return patches
        emit_and_broadcast(run_id, "verify.failed", {"attempt": attempt, **result.__dict__})
        if attempt > MAX_VERIFY_RETRIES:
            raise RuntimeError(f"verify 失败，已重试 {MAX_VERIFY_RETRIES} 次")
        attempt += 1
        changes.meta = {**changes.meta, "verifyError": result.stderr[:2000], "verifyStdout": result.stdout[:2000]}


async def replay_from(run_id: str, from_event_index: int, new_raw_text: str) -> None:
    event_store.truncate_after(run_id, from_event_index)
    emit_and_broadcast(run_id, "run.intervened", {"fromEventIndex": from_event_index, "newRawText": new_raw_text})
    llm = create_doubao_client({"runId": run_id})
    repo = create_conduit_repo()
    asyncio.create_task(_run_pipeline(run_id, new_raw_text, llm, repo))


def get_run_events(run_id: str) -> list[RunEvent]:
    return event_store.read_events(run_id)


def dismiss_recall(run_id: str, historical_run_id: str) -> bool:
    if not get_run_events(run_id):
        return False
    emit_and_broadcast(run_id, "recall.dismissed", {"historicalRunId": historical_run_id})
    return True


def get_run_phase(run_id: str) -> str | None:
    return run_phase.get(run_id)
