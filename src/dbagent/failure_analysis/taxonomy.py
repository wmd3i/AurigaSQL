"""Failure-category taxonomy — the single source of truth shared by both sides.

The analyzer (``dbagent.failure_analysis.analyzer``) writes one of
these category keys into each ``failure_analysis.json``; the viewer
(``loader``/``render``) color-codes and filters by them. Keep this module pure:
an enum-like dict plus display constants.

``failure_category`` is the LLM's *fine-grained root cause*. It is distinct from
dbAgent's objective ``error_type`` (``wrong_answer`` / ``execution_error`` /
``runtime_error`` / ``data_error`` / ``evaluation_error`` / ``other``), which is
recorded by the evaluator. The mapping is many-to-one: e.g. an
``error_type=wrong_answer`` may be diagnosed as ``schema_misuse`` or
``wrong_logic``.
"""

from __future__ import annotations

# key -> (label, hex color, one-line description shown in tooltips/legend).
# Colors are chosen to read on a light background and to be distinguishable.
CATEGORIES: dict[str, dict[str, str]] = {
    "schema_misuse": {
        "label": "Schema misuse",
        "label_zh": "Schema 误用",
        "color": "#c2410c",  # orange-700
        "description": "Referenced a wrong/nonexistent table or column, or misread the schema.",
        "description_zh": "引用了错误/不存在的表或列，或误读了 schema。",
    },
    "wrong_logic": {
        "label": "Wrong logic",
        "label_zh": "逻辑错误",
        "color": "#b91c1c",  # red-700
        "description": "SQL is valid but the aggregation/filter/ordering logic does not answer the question.",
        "description_zh": "SQL 语法正确，但聚合/过滤/排序逻辑没有回答问题。",
    },
    "wrong_join": {
        "label": "Join error",
        "label_zh": "连接错误",
        "color": "#a21caf",  # fuchsia-700
        "description": "Missing, extra, or incorrect JOIN / join key producing wrong rows.",
        "description_zh": "缺失、多余或错误的 JOIN / 连接键，导致结果行不正确。",
    },
    "missing_grouping": {
        "label": "Grouping/aggregation",
        "label_zh": "分组/聚合",
        "color": "#7c3aed",  # violet-600
        "description": "Missing or wrong GROUP BY / aggregate, duplicate rows, or bad DISTINCT.",
        "description_zh": "缺失或错误的 GROUP BY / 聚合、重复行，或错误的 DISTINCT。",
    },
    "value_or_format": {
        "label": "Value/format mismatch",
        "label_zh": "取值/格式不匹配",
        "color": "#0369a1",  # sky-700
        "description": "Right shape but wrong literal, casing, units, rounding, or column order.",
        "description_zh": "结果形状正确，但字面量、大小写、单位、舍入或列顺序有误。",
    },
    "execution_error": {
        "label": "Execution error",
        "label_zh": "执行错误",
        "color": "#92400e",  # amber-800
        "description": "The final SQL failed to execute (syntax, type, or binding error).",
        "description_zh": "最终 SQL 执行失败（语法、类型或绑定错误）。",
    },
    "runtime_or_infra": {
        "label": "Runtime/infra",
        "label_zh": "运行时/基础设施",
        "color": "#525252",  # neutral-600
        "description": "Agent crash, timeout, rate limit, or other non-SQL infrastructure failure.",
        "description_zh": "Agent 崩溃、超时、限流，或其他非 SQL 的基础设施故障。",
    },
    "ambiguous_question": {
        "label": "Ambiguous question",
        "label_zh": "有歧义的问题",
        "color": "#0f766e",  # teal-700
        "description": "Question/evidence is ambiguous; the gold answer relies on an unstated convention.",
        "description_zh": "问题/证据存在歧义；标准答案依赖于未明示的约定。",
    },
    "other": {
        "label": "Other",
        "label_zh": "其他",
        "color": "#475569",  # slate-600
        "description": "Does not fit the categories above.",
        "description_zh": "不属于上述任何类别。",
    },
}

# Canonical fallback used whenever a value is missing or unrecognized.
DEFAULT_CATEGORY = "other"

# Comma-joined list handy for embedding in the codex prompt.
CATEGORY_KEYS = list(CATEGORIES.keys())

# --- attribution: WHO/WHAT is responsible (the three top-level variables) -----
# Every failed case is attributed to exactly one of these so the run-level
# aggregation can answer "where should we spend effort?".
ATTRIBUTIONS: dict[str, dict[str, str]] = {
    "llm": {
        "label": "LLM",
        "label_zh": "大模型",
        "color": "#b91c1c",  # red-700
        "description": "The model's own mistake: bad SQL reasoning, ignored evidence, "
                       "wrong query despite correct tools and a well-posed question. "
                       "Fix = better model / prompting.",
        "description_zh": "模型自身的错误：SQL 推理有误、忽略证据，或在工具正常、"
                          "问题清晰的情况下仍写出错误查询。修复 = 更好的模型 / 提示词。",
    },
    "harness": {
        "label": "Harness",
        "label_zh": "框架",
        "color": "#1d4ed8",  # blue-700
        "description": "A framework issue (src/dbagent): tool behavior, schema "
                       "rendering, context truncation, SQL execution, or evaluation "
                       "normalization. Fix = the framework code.",
        "description_zh": "框架问题（src/dbagent）：工具行为、schema 渲染、上下文截断、"
                          "SQL 执行或评测归一化。修复 = 框架代码。",
    },
    "benchmark": {
        "label": "Benchmark",
        "label_zh": "基准/数据集",
        "color": "#15803d",  # green-700
        "description": "The benchmark/gold itself (src/dbagent/benchmarks or the "
                       "dataset): ambiguous question, wrong or non-canonical gold SQL, "
                       "unstated convention. Fix = the benchmark.",
        "description_zh": "基准/标准答案本身（src/dbagent/benchmarks 或数据集）：问题歧义、"
                          "标准 SQL 错误或非规范、存在未明示的约定。修复 = 基准本身。",
    },
}

DEFAULT_ATTRIBUTION = "llm"
ATTRIBUTION_KEYS = list(ATTRIBUTIONS.keys())


def normalize_attribution(value: str | None) -> str:
    if not value:
        return DEFAULT_ATTRIBUTION
    key = str(value).strip().lower().replace(" ", "_").replace("-", "_")
    if key in ATTRIBUTIONS:
        return key
    aliases = {
        "model": "llm",
        "agent": "llm",
        "framework": "harness",
        "tool": "harness",
        "tools": "harness",
        "evaluation": "harness",
        "evaluator": "harness",
        "eval": "harness",
        "infra": "harness",
        "infrastructure": "harness",
        "dataset": "benchmark",
        "gold": "benchmark",
        "question": "benchmark",
        "task": "benchmark",
    }
    return aliases.get(key, DEFAULT_ATTRIBUTION)


def attribution_label(value: str | None) -> str:
    return ATTRIBUTIONS[normalize_attribution(value)]["label"]


def attribution_label_zh(value: str | None) -> str:
    meta = ATTRIBUTIONS[normalize_attribution(value)]
    return meta.get("label_zh", meta["label"])


def attribution_color(value: str | None) -> str:
    return ATTRIBUTIONS[normalize_attribution(value)]["color"]


def normalize_category(value: str | None) -> str:
    """Map an arbitrary string to a known category key, falling back to 'other'.

    The LLM occasionally returns a near-miss (whitespace, casing, or a synonym).
    We normalize aggressively so the viewer never has to render an unknown key.
    """
    if not value:
        return DEFAULT_CATEGORY
    key = str(value).strip().lower().replace(" ", "_").replace("-", "_")
    if key in CATEGORIES:
        return key
    # A few tolerant aliases for common LLM phrasings.
    aliases = {
        "schema": "schema_misuse",
        "wrong_table": "schema_misuse",
        "wrong_column": "schema_misuse",
        "logic": "wrong_logic",
        "incorrect_logic": "wrong_logic",
        "join": "wrong_join",
        "join_error": "wrong_join",
        "missing_join": "wrong_join",
        "groupby": "missing_grouping",
        "group_by": "missing_grouping",
        "aggregation": "missing_grouping",
        "grouping": "missing_grouping",
        "format": "value_or_format",
        "value": "value_or_format",
        "value_mismatch": "value_or_format",
        "format_mismatch": "value_or_format",
        "syntax_error": "execution_error",
        "execution": "execution_error",
        "runtime": "runtime_or_infra",
        "infra": "runtime_or_infra",
        "timeout": "runtime_or_infra",
        "crash": "runtime_or_infra",
        "ambiguous": "ambiguous_question",
    }
    return aliases.get(key, DEFAULT_CATEGORY)


def category_label(value: str | None) -> str:
    return CATEGORIES[normalize_category(value)]["label"]


def category_label_zh(value: str | None) -> str:
    meta = CATEGORIES[normalize_category(value)]
    return meta.get("label_zh", meta["label"])


def category_color(value: str | None) -> str:
    return CATEGORIES[normalize_category(value)]["color"]
