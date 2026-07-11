"""Failure-analysis viewer.

This package is a READ-ONLY viewer over a run directory. It loads the
``cases/<case_id>/failure_analysis.json`` files that the runner writes during a
run and renders them into ``runs/<run_id>/failure_report.html`` (and serves a
live-refreshing version of the same page).

The viewer modules (``loader``/``aggregate``/``render``/``serve``) contain NO LLM
logic. The codex generation lives in the sibling ``analyzer`` module; the
dependency points one way — ``analyzer`` may use the viewer modules, never the
reverse. ``taxonomy.py`` holds the enums both sides share.
"""

from .taxonomy import (
    ATTRIBUTIONS,
    CATEGORIES,
    attribution_color,
    attribution_label,
    attribution_label_zh,
    category_color,
    category_label,
    category_label_zh,
    normalize_attribution,
    normalize_category,
)

__all__ = [
    "ATTRIBUTIONS",
    "CATEGORIES",
    "attribution_color",
    "attribution_label",
    "attribution_label_zh",
    "category_color",
    "category_label",
    "category_label_zh",
    "normalize_attribution",
    "normalize_category",
]
