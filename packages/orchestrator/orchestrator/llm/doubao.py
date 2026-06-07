from __future__ import annotations

import os
import time
from typing import Any, Protocol

from orchestrator.events.store import emit


class LLMClient(Protocol):
    async def chat(
        self,
        messages: list[dict[str, str]],
        opts: dict[str, Any] | None = None,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...


def estimate_cost_cny(_model: str, _prompt_tokens: int, _completion_tokens: int) -> float:
    return 0.0


class DoubaoClient:
    def __init__(self, run_id: str | None = None):
        self.run_id = run_id
        self.api_key = os.getenv("DOUBAO_API_KEY")
        self.ep_id = os.getenv("DOUBAO_EP_ID")
        self.base_url = os.getenv("DOUBAO_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
        if not self.api_key:
            raise RuntimeError("DOUBAO_API_KEY env var is not set")
        if not self.ep_id:
            raise RuntimeError("DOUBAO_EP_ID env var is not set")

        from openai import AsyncOpenAI

        self.client = AsyncOpenAI(api_key=self.api_key, base_url=self.base_url)

    async def chat(
        self,
        messages: list[dict[str, str]],
        opts: dict[str, Any] | None = None,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = opts or {}
        meta = meta or {}
        agent = meta.get("agent", "unknown")
        attempt = int(meta.get("attempt", 1))
        start = time.time()
        response = await self.client.chat.completions.create(
            model=self.ep_id,
            messages=messages,  # type: ignore[arg-type]
            temperature=opts.get("temperature", 0.3),
            max_tokens=opts.get("maxTokens", 4096),
        )
        latency_ms = int((time.time() - start) * 1000)
        prompt_tokens = int(getattr(response.usage, "prompt_tokens", 0) or 0)
        completion_tokens = int(getattr(response.usage, "completion_tokens", 0) or 0)
        text = response.choices[0].message.content or ""
        cost = estimate_cost_cny(self.ep_id, prompt_tokens, completion_tokens)
        effective_run_id = meta.get("runId") or self.run_id or "_global"
        emit(
            effective_run_id,
            "llm.call",
            {
                "agent": agent,
                "model": self.ep_id,
                "attempt": attempt,
                "promptTokens": prompt_tokens,
                "completionTokens": completion_tokens,
                "latencyMs": latency_ms,
                "costCNY": cost,
            },
        )
        return {
            "text": text,
            "usage": {
                "promptTokens": prompt_tokens,
                "completionTokens": completion_tokens,
                "latencyMs": latency_ms,
                "costCNY": cost,
            },
        }


def create_doubao_client(defaults: dict[str, Any] | None = None) -> DoubaoClient:
    defaults = defaults or {}
    return DoubaoClient(run_id=defaults.get("runId"))

