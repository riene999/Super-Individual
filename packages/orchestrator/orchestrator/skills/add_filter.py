from __future__ import annotations

from orchestrator.skills.base import Skill
from orchestrator.types import FileStep


add_filter = Skill(
    name="add-filter",
    description="为文章列表新增筛选项，适用于“按 X 筛选”“只看 X”类需求，会扩展后端 query 参数和前端筛选 UI。",
    required_words=["筛选", "过滤", "filter", "只看", "filter by"],
    possible_aspects=["filter-criteria", "filter-options", "filter-ui-placement", "data-source"],
    aspect_question_template={
        "filter-criteria": {"question": "请说明按什么字段筛选", "example": "例如：按 body 字数 / 发布时间 / favoritesCount"},
        "filter-options": {"question": "请说明可选项有哪些", "example": "例如：短文 / 中等 / 长文"},
        "filter-ui-placement": {"question": "请说明筛选 UI 放在哪里", "example": "例如：FeedToggler 的 nav-pills 末尾"},
        "data-source": {"question": "请说明后端怎么实现筛选", "example": "例如：Sequelize.where + Op.between"},
    },
    match_words=[
        "筛选", "过滤", "只看", "按",
        "字数", "长文", "短文", "篇幅", "区间", "范围",
        "filter", "by", "word", "length", "range", "short", "long",
    ],
    match_threshold=3,
    build_steps=lambda req, _ctx: [
        FileStep(
            path="backend/controllers/articles.js",
            mode="modify",
            instruction=f"在 allArticles 控制器中扩展 req.query，新增筛选维度：{req.businessRule}。参数名约定为 `{req.fieldName}`，保留现有 author/tag/favorited 逻辑。",
        ),
        FileStep(
            path="frontend/src/services/getArticles.js",
            mode="modify",
            instruction=f"给 getArticles 增加 `{req.fieldName}` 参数，并把它拼到 global feed URL，保留现有 URL 分支。",
        ),
        FileStep(
            path="frontend/src/hooks/useArticles.js",
            mode="modify",
            instruction=f"useArticles hook 增加 `{req.fieldName}` 入参，在 useEffect 依赖里加上它并传给 getArticles。",
        ),
        FileStep(
            path="frontend/src/components/FeedToggler/FeedToggler.jsx",
            mode="modify",
            instruction=f"在 nav-pills 末尾追加筛选 UI（位置：{req.displayLocation}），实现：{req.businessRule}。",
        ),
    ],
)

