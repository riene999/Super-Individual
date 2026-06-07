from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[4]
EVENTS_DIR = Path(os.getenv("EVENTS_DIR", str(ROOT / "events")))


def _read_events(run_id: str) -> list[dict[str, Any]]:
    path = EVENTS_DIR / f"{run_id}.jsonl"
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0
    values = sorted(values)
    if len(values) == 1:
        return values[0]
    idx = (p / 100) * (len(values) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(values) - 1)
    if lo == hi:
        return values[lo]
    return values[lo] + (values[hi] - values[lo]) * (idx - lo)


def _stats(calls: list[dict[str, Any]]) -> dict[str, Any]:
    latencies = [float(c.get("latencyMs", 0)) for c in calls]
    return {
        "count": len(calls),
        "totalTokens": sum(int(c.get("promptTokens", 0)) + int(c.get("completionTokens", 0)) for c in calls),
        "totalCostCNY": sum(float(c.get("costCNY", 0)) for c in calls),
        "latency": {
            "min": min(latencies) if latencies else 0,
            "median": _percentile(latencies, 50),
            "max": max(latencies) if latencies else 0,
            "p50": _percentile(latencies, 50),
            "p95": _percentile(latencies, 95),
        },
    }


def _group_by_agent(calls: list[dict[str, Any]]) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for c in calls:
        groups.setdefault(str(c.get("agent", "unknown")), []).append(c)
    return {agent: _stats(items) for agent, items in groups.items()}


def aggregate_run(run_id: str) -> dict[str, Any]:
    events = [e for e in _read_events(run_id) if e.get("type") == "llm.call"]
    calls = [e.get("payload", {}) for e in events]
    return {
        "runId": run_id,
        "hasLlmEvents": bool(events),
        "calls": [
            {
                "agent": e.get("payload", {}).get("agent"),
                "ts": e.get("ts"),
                "attempt": e.get("payload", {}).get("attempt"),
                "latencyMs": e.get("payload", {}).get("latencyMs"),
                "promptTokens": e.get("payload", {}).get("promptTokens"),
                "completionTokens": e.get("payload", {}).get("completionTokens"),
                "costCNY": e.get("payload", {}).get("costCNY"),
            }
            for e in events
        ],
        "byAgent": _group_by_agent(calls),
        "overall": _stats(calls),
    }


def aggregate_global() -> dict[str, Any]:
    if not EVENTS_DIR.exists():
        return {"totalRuns": 0, "overall": _stats([]), "byAgent": {}}
    files = list(EVENTS_DIR.glob("*.jsonl"))
    calls: list[dict[str, Any]] = []
    for f in files:
        for line in f.read_text(encoding="utf-8").splitlines():
            try:
                e = json.loads(line)
                if e.get("type") == "llm.call":
                    calls.append(e.get("payload", {}))
            except Exception:
                pass
    return {
        "totalRuns": len([f for f in files if f.name != "_global.jsonl"]),
        "overall": _stats(calls),
        "byAgent": _group_by_agent(calls),
    }


def compare_runs(baseline: str, with_recall: str) -> dict[str, Any]:
    return {
        "baseline": {"runId": baseline, "metrics": aggregate_run(baseline)},
        "withRecall": {"runId": with_recall, "metrics": aggregate_run(with_recall)},
        "diff": None,
    }

