from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from orchestrator.metrics.aggregator import aggregate_global, aggregate_run, compare_runs
from orchestrator.orchestrator import (
    bus,
    dismiss_recall,
    get_run_events,
    get_run_phase,
    provide_clarification_answers,
    replay_from,
    start_run,
)
from orchestrator.skills.registry import load_skills

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RunCreate(BaseModel):
    text: str


class DismissRecall(BaseModel):
    historicalRunId: str


class Intervention(BaseModel):
    type: str
    answers: dict[str, str] | None = None
    fromEventIndex: int | None = None
    newText: str | None = None


def event_to_dict(event) -> dict[str, Any]:
    return event.__dict__


def err(msg: str) -> dict[str, str]:
    return {"error": msg}


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/skills")
async def skills():
    loaded = await load_skills()
    return [{"name": s.name, "description": s.description} for s in loaded]


@app.post("/api/runs")
async def runs(body: RunCreate):
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail=err("text is required"))
    run_id = await start_run(text)
    return {"runId": run_id}


@app.get("/api/runs/{run_id}/stream")
async def run_stream(run_id: str):
    async def gen():
        for event in get_run_events(run_id):
            yield f"data: {json.dumps(event_to_dict(event), ensure_ascii=False)}\n\n"
        async for queue in bus.subscribe(run_id):
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event_to_dict(event), ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "Connection": "keep-alive"})


@app.get("/api/runs/{run_id}")
async def run_detail(run_id: str):
    events = get_run_events(run_id)
    if not events:
        raise HTTPException(status_code=404, detail=err("run not found"))
    return {"runId": run_id, "phase": get_run_phase(run_id) or "done", "events": [event_to_dict(e) for e in events]}


@app.post("/api/runs/{run_id}/dismiss-recall")
async def dismiss(run_id: str, body: DismissRecall):
    if not body.historicalRunId:
        raise HTTPException(status_code=400, detail=err("historicalRunId is required"))
    ok = dismiss_recall(run_id, body.historicalRunId)
    if not ok:
        raise HTTPException(status_code=404, detail=err("run not found"))
    return {"ok": True}


@app.post("/api/runs/{run_id}/intervene")
async def intervene(run_id: str, body: Intervention):
    if body.type == "answer":
        ok = provide_clarification_answers(run_id, body.answers or {})
        if not ok:
            raise HTTPException(status_code=409, detail=err("run is not waiting for answers"))
        return {"ok": True}
    if body.type == "replay":
        asyncio.create_task(replay_from(run_id, body.fromEventIndex or 0, body.newText or ""))
        return {"ok": True, "replaying": True}
    raise HTTPException(status_code=400, detail=err("unknown intervention type"))


@app.get("/api/metrics")
async def metrics():
    return aggregate_global()


@app.get("/api/runs/{run_id}/metrics")
async def run_metrics(run_id: str):
    return aggregate_run(run_id)


@app.get("/api/runs/compare/{baseline}/{with_recall}")
async def compare(baseline: str, with_recall: str):
    return compare_runs(baseline, with_recall)

