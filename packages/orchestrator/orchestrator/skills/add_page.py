from __future__ import annotations

import re

from orchestrator.skills.base import Skill
from orchestrator.types import ClarifiedRequest, FileStep, RepoContext


def derive_names(req: ClarifiedRequest) -> tuple[str, str, str]:
    camel = req.fieldName or "newPage"
    pascal = camel[:1].upper() + camel[1:]
    kebab = re.sub(r"([A-Z])", r"-\1", camel).lower().lstrip("-")
    return pascal, kebab, camel


def build_steps(req: ClarifiedRequest, _ctx: RepoContext) -> list[FileStep]:
    page_name, route_url, file_base = derive_names(req)
    return [
        FileStep(
            path=f"backend/routes/{file_base}.js",
            mode="create",
            instruction=f"创建 Express Router 文件。需求：{req.businessRule}。导出方式与现有 routes 一致，GET / 返回聚合结果 JSON。",
        ),
        FileStep(
            path="backend/index.js",
            mode="modify",
            instruction=f"注册 app.use('/api/{route_url}', {file_base}Routes)，并添加 require('./routes/{file_base}')。",
        ),
        FileStep(
            path=f"frontend/src/routes/{page_name}.jsx",
            mode="create",
            instruction=f"创建 React 函数组件 {page_name}，从 /api/{route_url} fetch 数据并展示。需求：{req.businessRule}。",
        ),
        FileStep(
            path="frontend/src/main.jsx",
            mode="modify",
            instruction=f"导入 {page_name} 并增加 <Route path=\"{route_url}\" element={{<{page_name} />}} />。",
        ),
    ]


def reference_for(step: FileStep, _ctx: RepoContext) -> str | None:
    if step.mode != "create":
        return None
    if step.path.startswith("backend/routes/"):
        return "backend/routes/tags.js"
    if step.path.startswith("frontend/src/routes/"):
        return "frontend/src/routes/HomeArticles.jsx"
    return None


def custom_match(req: ClarifiedRequest, score: float) -> float:
    haystack = " ".join([req.summary, req.fieldName, req.businessRule, req.displayLocation]).lower()
    if ("tab" in haystack or "标签页" in haystack) and ("现有" in haystack or "existing" in haystack):
        return 0.0
    return score


add_page = Skill(
    name="add-page",
    description="新增一个只读页面，适用于“新增 X 页面 / X 榜 / X 排行”类需求。",
    required_words=["页面", "页", "page", "榜", "排行", "leaderboard", "ranking"],
    possible_aspects=["route-path", "page-name", "data-source", "display-position", "sort-rule"],
    aspect_question_template={
        "route-path": {"question": "请说明前端路由路径", "example": "例如：popular-tags / top-authors"},
        "page-name": {"question": "请说明页面组件名", "example": "例如：PopularTags / TopAuthors"},
        "data-source": {"question": "请说明后端从哪些表/字段聚合数据", "example": "例如：Tag 表 JOIN ArticleTag"},
        "display-position": {"question": "请说明页面入口", "example": "例如：Navbar 增加 Popular Tags 链接"},
        "sort-rule": {"question": "请说明结果排序规则", "example": "例如：articlesCount 降序"},
    },
    match_words=[
        "页面", "新增页", "新页", "页", "新建页",
        "榜", "排行", "排行榜", "热门", "聚合",
        "page", "new page", "ranking", "leaderboard", "popular", "aggregate",
    ],
    match_threshold=3,
    build_steps=build_steps,
    reference_for=reference_for,
    custom_match=custom_match,
)

