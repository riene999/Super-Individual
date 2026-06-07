from __future__ import annotations

from orchestrator.skills.base import Skill
from orchestrator.types import FileStep


add_field = Skill(
    name="add-field",
    description="在文章模型和前端组件中新增一个计算/虚拟字段并展示，适用于“在文章卡片上显示 X”类需求。",
    required_words=["字段", "field", "卡片", "card", "每篇", "时长", "字数"],
    possible_aspects=["field-name", "field-type", "display-position", "calculation-rule"],
    aspect_question_template={
        "field-name": {"question": "请说明新字段的英文名（camelCase）", "example": "例如：readingTime / wordCount / shareCount"},
        "field-type": {"question": "请说明字段的数据类型", "example": "例如：integer / string / boolean"},
        "display-position": {"question": "请说明字段在前端展示的位置", "example": "例如：ArticleMeta 组件，日期旁边"},
        "calculation-rule": {"question": "请说明字段值如何计算/获取", "example": "例如：正文字数 / 200 向上取整，最少 1 分钟"},
    },
    match_words=[
        "字段", "显示", "展示", "看到", "新增", "添加", "统计", "计算",
        "时间", "分钟", "数量", "个数", "字数",
        "field", "add", "show", "display", "read", "time", "count", "word",
    ],
    match_threshold=4,
    build_steps=lambda req, _ctx: [
        FileStep(
            path="backend/models/Article.js",
            mode="modify",
            instruction=f"添加 VIRTUAL 字段 `{req.fieldName}`，getter 实现：{req.businessRule}",
        ),
        FileStep(
            path="frontend/src/components/ArticleMeta/ArticleMeta.jsx",
            mode="modify",
            instruction=f"接收并展示 `{req.fieldName}`（位置：{req.displayLocation}）",
        ),
        FileStep(
            path="frontend/src/components/ArticlesPreview/ArticlesPreview.jsx",
            mode="modify",
            instruction=f"将 article.{req.fieldName} 传给 ArticleMeta",
        ),
    ],
)

