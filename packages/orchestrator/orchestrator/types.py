from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


FieldType = Literal["integer", "float", "string", "boolean"]
FileMode = Literal["modify", "create"]
Layer = Literal["backend", "frontend", "db"]
Outcome = Literal["verified", "failed"]
PlanMode = Literal["skill", "generic"]
RoutingDecision = Literal["keyword", "llm-router"]


@dataclass
class ClarifyingQuestion:
    q: str
    aspect: str = "other"


@dataclass
class ClarifiedRequest:
    summary: str
    fieldName: str
    fieldType: FieldType
    displayLocation: str
    businessRule: str
    clarifyingQuestions: list[ClarifyingQuestion] = field(default_factory=list)
    answers: dict[str, str] | None = None


@dataclass
class FileStep:
    path: str
    mode: FileMode
    instruction: str


@dataclass
class SkillPlan:
    skillName: str
    files: list[FileStep]
    # 跨文件必须一致的接口约定（组件名/导入路径/接口地址/字段名等），由规划阶段产出，生成阶段严格遵守
    contract: str = ""


@dataclass
class FileChange:
    path: str
    reason: str


@dataclass
class ChangeSet:
    files: list[FileChange]
    context: dict[str, str]
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class FilePatch:
    path: str
    newContent: str


@dataclass
class RepoContext:
    repoPath: str
    branch: str
    codeSpecContext: str | None = None
    # 选中相关文件的“符号地图”（path + 导出符号 + 真实 import 写法），喂给生成阶段做 grounding
    codeSpecSymbolMap: str | None = None


@dataclass
class RunEvent:
    type: str
    runId: str
    ts: int
    payload: dict[str, Any]


@dataclass
class AspectTemplate:
    question: str
    example: str


@dataclass
class ExtractedEntities:
    domainObjects: list[str] = field(default_factory=list)
    operations: list[str] = field(default_factory=list)
    affectedLayers: list[Layer] = field(default_factory=list)
    fieldsAdded: list[str] = field(default_factory=list)
    uiSurfaces: list[str] = field(default_factory=list)


@dataclass
class ClarificationQA:
    q: str
    a: str
    aspect: str = "other"


@dataclass
class RequestMemory:
    runId: str
    ts: int
    summary: str
    skillUsed: str | None
    entities: ExtractedEntities
    changedFiles: list[str]
    clarifications: list[ClarificationQA]
    outcome: Outcome
    mode: PlanMode = "skill"
    genericPlanFiles: list[str] | None = None
    repoNwo: str | None = None


@dataclass
class RecallMatch:
    memory: RequestMemory
    score: float
    matchedDimensions: list[str]


def dataclass_to_json(value: Any) -> Any:
    if hasattr(value, "__dataclass_fields__"):
        return {k: dataclass_to_json(getattr(value, k)) for k in value.__dataclass_fields__}
    if isinstance(value, list):
        return [dataclass_to_json(v) for v in value]
    if isinstance(value, dict):
        return {k: dataclass_to_json(v) for k, v in value.items()}
    return value
