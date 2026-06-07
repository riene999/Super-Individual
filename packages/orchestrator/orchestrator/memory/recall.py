from __future__ import annotations

from orchestrator.types import ExtractedEntities, RecallMatch, RequestMemory


def _intersect(a: list, b: list) -> list:
    bs = set(b)
    return [x for x in a if x in bs]


def _jaccard(a: list, b: list) -> float:
    if not a and not b:
        return 0.0
    union = set(a) | set(b)
    return len(_intersect(a, b)) / len(union) if union else 0.0


def score(query: ExtractedEntities, candidate: RequestMemory) -> RecallMatch:
    a = query
    b = candidate.entities
    dims: list[str] = []
    s = 0.0
    if _intersect(a.operations, b.operations):
        s += 0.40
        dims.append("同样的操作类型")
    obj = _jaccard(a.domainObjects, b.domainObjects)
    if obj > 0:
        s += 0.30 * obj
        dims.append(f"涉及相同对象: {', '.join(_intersect(a.domainObjects, b.domainObjects))}")
    ui = _intersect(a.uiSurfaces, b.uiSurfaces)
    if ui:
        s += 0.20
        dims.append(f"涉及相同组件: {', '.join(ui)}")
    if _intersect(a.affectedLayers, b.affectedLayers):
        s += 0.10
    if candidate.outcome == "failed":
        s *= 0.5
    return RecallMatch(memory=candidate, score=min(s, 1.0), matchedDimensions=dims)


def recall(query: ExtractedEntities, memories: list[RequestMemory], top_k: int = 3, min_score: float = 0.3) -> list[RecallMatch]:
    scored = [score(query, m) for m in memories]
    return sorted([m for m in scored if m.score >= min_score], key=lambda x: x.score, reverse=True)[:top_k]

