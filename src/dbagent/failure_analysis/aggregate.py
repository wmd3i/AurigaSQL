"""Deterministic run-level aggregation (no LLM).

Turns a list of per-case analyses into the distributions the report shows:
  1. typical issues + percentage  -> by_category
  2. who is responsible           -> by_attribution (llm / harness / benchmark)
  3. objective error buckets       -> by_error_type
plus coverage (how many failures were actually analyzed).

The LLM-written *narrative* suggestion is added separately by
``analyzer.summarize_run``; this module only does counting, so the
viewer can compute live stats while a run is still in progress.
"""

from __future__ import annotations

from collections import Counter
from typing import TYPE_CHECKING

from .taxonomy import (
    ATTRIBUTIONS,
    CATEGORIES,
    normalize_attribution,
    normalize_category,
)

if TYPE_CHECKING:
    from .loader import RunView


def _distribution(counts: Counter, total: int, meta: dict) -> list[dict]:
    """Sorted list of {key,label,color,count,pct} for a counter."""
    out = []
    for key, count in counts.most_common():
        out.append({
            "key": key,
            "label": meta.get(key, {}).get("label", key),
            "color": meta.get(key, {}).get("color", "#475569"),
            "count": count,
            "pct": round(100.0 * count / total, 1) if total else 0.0,
        })
    return out


def aggregate(run: "RunView") -> dict:
    """Compute deterministic stats over the DONE analyses in a RunView."""
    analyzed = [c for c in run.failed if c.analysis_state == "DONE" and c.analysis]

    cat_counts: Counter = Counter()
    attr_counts: Counter = Counter()
    err_counts: Counter = Counter()
    # Cross-tab: which categories drive each attribution bucket.
    attr_to_cats: dict[str, Counter] = {k: Counter() for k in ATTRIBUTIONS}

    for c in analyzed:
        cat = normalize_category(c.failure_category)
        attr = normalize_attribution(c.attribution)
        cat_counts[cat] += 1
        attr_counts[attr] += 1
        attr_to_cats[attr][cat] += 1
        if c.error_type:
            err_counts[str(c.error_type)] += 1

    n = len(analyzed)
    failed_total = len(run.failed)

    return {
        "failed_cases": failed_total,
        "analyzed_cases": n,
        "pending_cases": sum(1 for c in run.failed if c.analysis_state == "PENDING"),
        "running_cases": sum(1 for c in run.failed if c.analysis_state == "RUNNING"),
        "analysis_failed_cases": sum(1 for c in run.failed if c.analysis_state == "FAILED"),
        "coverage_pct": round(100.0 * n / failed_total, 1) if failed_total else 0.0,
        "by_category": _distribution(cat_counts, n, CATEGORIES),
        "by_attribution": _distribution(attr_counts, n, ATTRIBUTIONS),
        "by_error_type": _distribution(err_counts, n, {}),
        "attribution_breakdown": {
            attr: _distribution(cats, sum(cats.values()), CATEGORIES)
            for attr, cats in attr_to_cats.items() if sum(cats.values())
        },
        "top_category": cat_counts.most_common(1)[0][0] if cat_counts else None,
        "top_attribution": attr_counts.most_common(1)[0][0] if attr_counts else None,
    }
