import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  startRun,
  provideClarificationAnswers,
  replayFrom,
  getRunEvents,
  getRunPhase,
  dismissRecall,
  bus,
} from "../../../packages/orchestrator/src/orchestrator.js";
import { loadSkills } from "../../../packages/orchestrator/src/skills/registry.js";
import { aggregateRun, aggregateGlobal, compareRuns } from "../../../packages/orchestrator/src/metrics/aggregator.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3001);

// ── GET /api/health ─────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// ── GET /api/skills ─────────────────────────────────────────
app.get("/api/skills", async (_req, res) => {
  const skills = await loadSkills();
  res.json(skills.map((s) => ({ name: s.name, description: s.description })));
});

// ── POST /api/runs ──────────────────────────────────────────
app.post("/api/runs", async (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text?.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const runId = await startRun(text.trim());
  res.json({ runId });
});

// ── GET /api/runs/:id/stream  (SSE) ─────────────────────────
app.get("/api/runs/:id/stream", (req, res) => {
  const { id } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // 先把历史事件全部补发给刚连接的客户端
  const history = getRunEvents(id);
  for (const event of history) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const handler = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  bus.on(`run:${id}`, handler);

  req.on("close", () => {
    bus.off(`run:${id}`, handler);
  });
});

// ── GET /api/runs/:id ───────────────────────────────────────
app.get("/api/runs/:id", (req, res) => {
  const { id } = req.params;
  const events = getRunEvents(id);
  if (!events.length) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json({ runId: id, phase: getRunPhase(id) ?? "done", events });
});

// ── POST /api/runs/:id/dismiss-recall ───────────────────────
app.post("/api/runs/:id/dismiss-recall", (req, res) => {
  const { historicalRunId } = req.body as { historicalRunId?: string };
  if (!historicalRunId) {
    res.status(400).json({ error: "historicalRunId is required" });
    return;
  }
  const ok = dismissRecall(req.params.id, historicalRunId);
  if (!ok) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json({ ok: true });
});

// ── GET /api/metrics  (全局聚合) ────────────────────────────
app.get("/api/metrics", (_req, res) => {
  res.json(aggregateGlobal());
});

// ── GET /api/runs/:id/metrics  (单 run 聚合) ────────────────
app.get("/api/runs/:id/metrics", (req, res) => {
  res.json(aggregateRun(req.params.id));
});

// ── GET /api/runs/compare/:baseline/:withRecall  (召回前后对比) ──
app.get("/api/runs/compare/:baseline/:withRecall", (req, res) => {
  res.json(compareRuns(req.params.baseline, req.params.withRecall));
});

// ── POST /api/runs/:id/intervene ────────────────────────────
app.post("/api/runs/:id/intervene", (req, res) => {
  const { id } = req.params;
  const body = req.body as {
    type: "answer" | "replay";
    answers?: Record<string, string>;
    fromEventIndex?: number;
    newText?: string;
  };

  if (body.type === "answer") {
    const ok = provideClarificationAnswers(id, body.answers ?? {});
    if (!ok) {
      res.status(409).json({ error: "run is not waiting for answers" });
      return;
    }
    res.json({ ok: true });
    return;
  }

  if (body.type === "replay") {
    const idx = body.fromEventIndex ?? 0;
    const newText = body.newText ?? "";
    replayFrom(id, idx, newText).catch(console.error);
    res.json({ ok: true, replaying: true });
    return;
  }

  res.status(400).json({ error: "unknown intervention type" });
});


app.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
});
