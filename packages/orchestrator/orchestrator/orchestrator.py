from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from pathlib import Path
from typing import Any
from uuid import uuid4

from orchestrator.agents import code, code_spec, locate, plan_loop, verify
from orchestrator.agents.generic_plan import generic_skill
from orchestrator.events import store as event_store
from orchestrator.llm.doubao import create_doubao_client
from orchestrator.memory.extract import extract_entities
from orchestrator.memory.recall import recall
from orchestrator.memory.store import persist_memory, read_all_memories
from orchestrator.repo.conduit import ConduitRepo, create_conduit_repo
from orchestrator.skills.library_loader import load_skill_docs
from orchestrator.types import ChangeSet, RunEvent, dataclass_to_json

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
run_repos: dict[str, ConduitRepo] = {}
run_tasks: dict[str, asyncio.Task] = {}


def emit_and_broadcast(run_id: str, event_type: str, payload: dict[str, Any]) -> RunEvent:
    event = event_store.emit(run_id, event_type, payload)
    bus.emit(event)
    return event


def _branch_slug(title: str) -> str:
    slug = "".join(c if (c.isascii() and c.isalnum()) else "-" for c in title.strip().lower())
    slug = "-".join(part for part in slug.split("-") if part)
    return slug[:40].strip("-") or "change"


def _plan_payload_files(files) -> list[dict[str, Any]]:
    return [dataclass_to_json(f) for f in files]


async def start_run(raw_text: str, repo_url: str | None = None) -> str:
    run_id = str(uuid4())
    llm = create_doubao_client({"runId": run_id})
    repo = ConduitRepo.from_url(repo_url) if repo_url else create_conduit_repo()
    run_repos[run_id] = repo
    task = asyncio.create_task(_run_pipeline(run_id, raw_text, llm, repo))
    run_tasks[run_id] = task
    return run_id


def provide_clarification_answers(run_id: str, answers: dict[str, str]) -> bool:
    fut = pending_answers.pop(run_id, None)
    if not fut or fut.done():
        return False
    fut.set_result(answers)
    return True


def stop_run(run_id: str) -> bool:
    task = run_tasks.get(run_id)
    if not task or task.done():
        return False

    fut = pending_answers.pop(run_id, None)
    if fut and not fut.done():
        fut.cancel()

    task.cancel()
    return True


def is_run_active(run_id: str) -> bool:
    task = run_tasks.get(run_id)
    return bool(task and not task.done())


async def _wait_for_answers(run_id: str) -> dict[str, str]:
    fut: asyncio.Future[dict[str, str]] = asyncio.get_running_loop().create_future()
    pending_answers[run_id] = fut
    return await fut


async def _run_pipeline(run_id: str, raw_text: str, llm, repo) -> None:
    try:
        emit_and_broadcast(
            run_id,
            "run.started",
            {
                "rawText": raw_text,
                "recallDisabled": False,
                "repoPath": str(repo.repo_path),
                "repoNwo": repo.upstream_nwo,
            },
        )
        # ---- recall：检索相似历史需求，作为规划知识源 ----
        run_phase[run_id] = "recall"
        recall_matches: list[dict[str, Any]] = []
        try:
            query_entities = await extract_entities(llm, run_id=run_id, summary=raw_text, skill_used="")
            repo_nwo = run_repos.get(run_id, None)
            repo_nwo_str = repo_nwo.upstream_nwo if repo_nwo else None
            matches = recall(query_entities, read_all_memories(), top_k=3, min_score=0.3, repo_nwo=repo_nwo_str)
            if matches:
                recall_matches = [
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
                emit_and_broadcast(run_id, "recall.matched", {"queryEntities": query_entities.__dict__, "matches": recall_matches})
        except Exception:
            pass

        # ---- code-spec：建/更新索引，算出相关文件摘要 ----
        run_phase[run_id] = "code-spec"
        ctx = repo.get_context()
        code_spec_context = None
        try:
            spec_status = await code_spec.ensure_current(repo, llm, run_id)
            code_spec_context = code_spec.format_relevant_context(raw_text, repo)
            ctx.codeSpecContext = code_spec_context
            emit_and_broadcast(run_id, "spec.ready", spec_status)
        except Exception as e:
            emit_and_broadcast(run_id, "spec.failed", {"message": str(e)})

        # ---- plan-loop：规划与澄清合一。plan agent 自评信息是否足够，不够才提问，最多 N 轮，到顶强制出规划 ----
        run_phase[run_id] = "plan"
        skills_context = load_skill_docs()
        recall_context = plan_loop.format_recall_context(recall_matches)
        qa_history: list[tuple[str, str]] = []
        plan_out = None
        for round_idx in range(plan_loop.MAX_QUESTION_ROUNDS + 1):
            force_ready = round_idx == plan_loop.MAX_QUESTION_ROUNDS
            plan_out = await plan_loop.plan_step(
                raw_text,
                ctx,
                llm,
                skills_context=skills_context,
                code_spec_context=code_spec_context,
                recall_context=recall_context,
                qa_history=qa_history,
                force_ready=force_ready,
            )
            if plan_out.status == "ready":
                break
            run_phase[run_id] = "clarify"
            emit_and_broadcast(
                run_id,
                "clarify.questions",
                {
                    "questions": plan_out.questions,
                    "partial": {"summary": raw_text},
                    "aspectScan": [],
                    "mode": "generic",
                    "round": round_idx + 1,
                },
            )
            answers = await _wait_for_answers(run_id)
            for q in plan_out.questions:
                qa_history.append((q, answers.get(q, "")))
            run_phase[run_id] = "plan"

        final_plan = plan_out.plan
        plan_title = plan_out.title or (raw_text[:48].strip() or "change")

        emit_and_broadcast(
            run_id,
            "clarify.done",
            {"req": {"summary": raw_text, "answers": {q: a for q, a in qa_history}}},
        )
        emit_and_broadcast(
            run_id,
            "plan.generic",
            {
                "mode": "generic",
                "plan": dataclass_to_json(final_plan),
                "files": _plan_payload_files(final_plan.files),
                "score": 0,
                "by": "plan-loop",
                "candidates": [],
                "routerReason": None,
                "reason": "plan-loop（规划与澄清合一）",
            },
        )

        skill = generic_skill
        run_phase[run_id] = "locate"
        changes = await locate.run(skill, final_plan, ctx)
        emit_and_broadcast(run_id, "locate.done", {"attempt": 1, "files": [f.__dict__ for f in changes.files], "fileCount": len(changes.files)})
        patches = await _run_code_and_verify(run_id, skill, changes, llm, repo)

        run_phase[run_id] = "code-spec:update"
        try:
            spec_update = await code_spec.update_files(repo, llm, [p.path for p in patches], run_id)
            emit_and_broadcast(run_id, "spec.updated", spec_update)
        except Exception as e:
            emit_and_broadcast(run_id, "spec.update_failed", {"message": str(e)})

        run_phase[run_id] = "commit"
        branch = f"feat/{_branch_slug(plan_title)}-{int(time.time() * 1000)}"
        repo.checkout_branch(branch)
        commit_msg = f"feat: {plan_title}\n\n{raw_text}"
        repo.stage_and_commit(commit_msg, [p.path for p in patches])

        run_phase[run_id] = "pr"
        pr_title = f"feat: {plan_title}"
        pr_body = raw_text or commit_msg
        repo.push_branch(branch)
        pr_url = repo.create_pr(branch, pr_title, pr_body)

        emit_and_broadcast(
            run_id,
            "commit.done",
            {"branch": branch, "commitMessage": commit_msg, "prDescription": pr_body, "patchCount": len(patches), "prUrl": pr_url},
        )
        emit_and_broadcast(run_id, "run.completed", {"runId": run_id})
        run_phase.pop(run_id, None)
        try:
            _repo = run_repos.get(run_id)
            await persist_memory(run_id, llm, repo_nwo=_repo.upstream_nwo if _repo else None)
        except Exception:
            pass
        run_repos.pop(run_id, None)
    except asyncio.CancelledError:
        emit_and_broadcast(
            run_id,
            "run.cancelled",
            {
                "phase": run_phase.get(run_id, "unknown"),
                "message": "Run stopped by user. Generated files may remain in the target worktree.",
            },
        )
        raise
    except Exception as e:
        emit_and_broadcast(run_id, "run.error", {"message": str(e)})
    finally:
        run_phase.pop(run_id, None)
        pending_answers.pop(run_id, None)
        run_tasks.pop(run_id, None)
        run_repos.pop(run_id, None)


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
        # 让下一次重试看到自己上一次生成的（未通过的）内容，而不是 locate 时抓的原始内容
        changes.context = {**changes.context, **{p.path: p.newContent for p in patches}}


async def replay_from(run_id: str, from_event_index: int, new_raw_text: str) -> None:
    event_store.truncate_after(run_id, from_event_index)
    emit_and_broadcast(run_id, "run.intervened", {"fromEventIndex": from_event_index, "newRawText": new_raw_text})
    llm = create_doubao_client({"runId": run_id})
    repo = run_repos.get(run_id)
    if repo is None:
        started = next((e for e in get_run_events(run_id) if e.type == "run.started"), None)
        repo_path = ((started.payload or {}).get("repoPath") if started else None) if started else None
        repo_nwo = ((started.payload or {}).get("repoNwo") if started else None) if started else None
        repo = ConduitRepo(Path(repo_path), upstream_nwo=repo_nwo) if repo_path else create_conduit_repo()
    run_repos[run_id] = repo
    task = asyncio.create_task(_run_pipeline(run_id, new_raw_text, llm, repo))
    run_tasks[run_id] = task


async def resume_run(run_id: str) -> bool:
    active = run_tasks.get(run_id)
    if active and not active.done():
        return False

    events = get_run_events(run_id)
    if not events:
        return False

    raw_text = ""
    for event in reversed(events):
        if event.type == "run.started":
            raw_text = str(event.payload.get("rawText") or "")
            break
    if not raw_text:
        return False

    safe_types = {"run.started", "clarify.done", "plan.done", "plan.generic", "locate.done", "code.done", "verify.done"}
    keep_count = 0
    for index, event in enumerate(events):
        if event.type in safe_types:
            keep_count = index + 1

    await replay_from(run_id, keep_count, raw_text)
    return True


def get_run_events(run_id: str) -> list[RunEvent]:
    return event_store.read_events(run_id)


def dismiss_recall(run_id: str, historical_run_id: str) -> bool:
    if not get_run_events(run_id):
        return False
    emit_and_broadcast(run_id, "recall.dismissed", {"historicalRunId": historical_run_id})
    return True


def get_run_phase(run_id: str) -> str | None:
    return run_phase.get(run_id)
