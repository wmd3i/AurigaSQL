"""Render a run's failure analyses into a self-contained HTML report.

``build_html(run_dir)`` returns a complete HTML string (inline CSS, no external
assets) — used both to bake ``failure_report.html`` and to serve the live page.
No LLM, no codex; this only reads what the loader/aggregator produce.

The report is **bilingual**: every user-facing string is emitted in both English
and Chinese, and a header toggle swaps the visible language client-side (no
re-render, no extra request). The English text is the default/baseline; the
Chinese text comes from the ``*_zh`` fields the analyzer writes (per-case
``summary_zh`` etc. and narrative ``*_zh``) and the static ``label_zh`` strings
in ``taxonomy.py``. When a ``*_zh`` field is missing (e.g. an older run analyzed
before bilingual output), the Chinese view falls back to the English text, so
every report renders in both languages regardless of age.

The ``live`` flag injects a tiny vanilla-JS poller that re-fetches ``/api/state``
and swaps the report body, so the served page updates while a run is in progress.
"""

from __future__ import annotations

import html
import json
from pathlib import Path

from .aggregate import aggregate
from .loader import RunView, load_run
from .taxonomy import (
    ATTRIBUTIONS,
    CATEGORIES,
    attribution_color,
    category_color,
)

# State badge: key -> (color, English label, 中文 label).
STATE_BADGE = {
    "DONE": ("#16a34a", "analyzed", "已分析"),
    "RUNNING": ("#ca8a04", "analyzing…", "分析中…"),
    "FAILED": ("#dc2626", "analysis failed", "分析失败"),
    "PENDING": ("#64748b", "not analyzed", "未分析"),
}

# Static UI strings: key -> (English, 中文). Rendered with ``_ui()``; the toggle
# swaps each ``.t`` node's textContent between its data-en / data-zh values.
_UI: dict[str, tuple[str, str]] = {
    "app_title": ("dbAgent · Failure Analysis", "dbAgent · 失败分析"),
    "live": ("● live · auto-refresh 3s", "● 实时 · 每 3 秒自动刷新"),
    "stat_run": ("run", "运行"),
    "stat_benchmark": ("benchmark", "基准"),
    "stat_accuracy": ("accuracy", "准确率"),
    "stat_failed": ("failed", "失败数"),
    "stat_analyzed": ("analyzed", "已分析"),
    "panel_issues": ("1 · Typical issues", "1 · 典型问题"),
    "panel_where": ("3 · Where the problem lives", "3 · 问题归属"),
    "panel_suggestions": ("2 · Suggestions", "2 · 建议"),
    "no_narrative": (
        "No LLM narrative available (run-level summary not generated). "
        "Distributions above are computed deterministically from the per-case analyses.",
        "暂无大模型总结（未生成运行级总结）。以上分布由各案例分析确定性统计得出。",
    ),
    "corrections_title": (
        "Attribution corrections (code contradicts per-case label):",
        "归属修正（代码与单案例标签相矛盾）：",
    ),
    "focus": ("★ focus", "★ 重点"),
    "case_switch_label": ("View failed cases", "查看失败案例"),
    "opt_all": ("All", "全部"),
    "opt_llm": ("LLM", "大模型"),
    "opt_harness": ("Harness", "框架"),
    "opt_benchmark": ("Benchmark", "基准/数据集"),
    "no_failed": ("No failed cases.", "没有失败案例。"),
    "no_data": ("no data", "暂无数据"),
    "field_summary": ("Summary", "摘要"),
    "field_root_cause": ("Root cause", "根因"),
    "field_evidence": ("Evidence", "证据"),
    "field_fix": ("Fix suggestion", "修复建议"),
    "confidence": ("confidence", "置信度"),
    "analysis_error": ("Analysis error", "分析错误"),
    "analyzing": ("codex is analyzing this case…", "codex 正在分析该案例…"),
    "no_analysis": ("No analysis yet.", "尚未分析。"),
    "corrected_banner": ("⚠ Corrected by run-level review:", "⚠ 已被运行级复核修正："),
    "sql": ("SQL", "SQL"),
    "predicted": ("predicted", "预测"),
    "gold": ("gold", "标准答案"),
}


def _esc(value) -> str:
    return html.escape("" if value is None else str(value))


def _t(en, zh=None) -> str:
    """A bilingual inline text node. Renders the English text by default (so a
    no-JS / no-toggle view is English); the language toggle swaps textContent to
    the Chinese value. Falls back to English when ``zh`` is empty/None."""
    en_s = _esc(en)
    zh_s = _esc(zh if (zh is not None and str(zh).strip()) else en)
    return f'<span class="t" data-en="{en_s}" data-zh="{zh_s}">{en_s}</span>'


def _ui(key: str) -> str:
    en, zh = _UI[key]
    return _t(en, zh)


def _dist_label_zh(d: dict) -> str:
    """Chinese label for a distribution entry, looked up by its taxonomy key.

    Re-deriving from the key keeps us robust to baked ``stats`` (in
    failure_summary.json) that predate the bilingual labels — error_type keys,
    which have no taxonomy entry, fall back to the English label."""
    key = d.get("key")
    if key in CATEGORIES:
        return CATEGORIES[key].get("label_zh", d["label"])
    if key in ATTRIBUTIONS:
        return ATTRIBUTIONS[key].get("label_zh", d["label"])
    return d.get("label_zh") or d["label"]


def _bar(dist: list[dict]) -> str:
    """Horizontal stacked percentage bar from a distribution list."""
    if not dist:
        return f'<div class="bar empty">{_ui("no_data")}</div>'
    segs = []
    for d in dist:
        if not d["pct"]:
            continue
        en_label = _esc(d["label"])
        zh_label = _esc(_dist_label_zh(d))
        tip_en = f'{en_label}: {d["count"]} ({d["pct"]}%)'
        tip_zh = f'{zh_label}: {d["count"]} ({d["pct"]}%)'
        segs.append(
            f'<span class="seg" style="width:{d["pct"]}%;background:{d["color"]}" '
            f'data-title-en="{tip_en}" data-title-zh="{tip_zh}" title="{tip_en}"></span>'
        )
    return f'<div class="bar">{"".join(segs)}</div>'


def _legend(dist: list[dict]) -> str:
    rows = []
    for d in dist:
        rows.append(
            f'<li><span class="dot" style="background:{d["color"]}"></span>'
            f'<span class="lg-label">{_t(d["label"], _dist_label_zh(d))}</span>'
            f'<span class="lg-num">{d["count"]} · {d["pct"]}%</span></li>'
        )
    return f'<ul class="legend">{"".join(rows)}</ul>'


def _suggestions_block(narrative: dict | None) -> str:
    if not narrative:
        return f'<p class="muted">{_ui("no_narrative")}</p>'
    parts = []
    overall = narrative.get("overall_summary")
    if overall:
        parts.append(f'<p class="overall">{_t(overall, narrative.get("overall_summary_zh"))}</p>')
    findings = narrative.get("key_findings") or []
    findings_zh = narrative.get("key_findings_zh") or []
    if findings:
        items = "".join(
            f"<li>{_t(f, findings_zh[i] if i < len(findings_zh) else None)}</li>"
            for i, f in enumerate(findings)
        )
        parts.append(f'<ul class="findings">{items}</ul>')

    focus = narrative.get("recommended_focus")
    sugg = narrative.get("suggestions") or {}
    sugg_zh = narrative.get("suggestions_zh") or {}
    cards = []
    for key in ("llm", "harness", "benchmark"):
        text = sugg.get(key) or "n/a"
        text_zh = sugg_zh.get(key)
        meta = ATTRIBUTIONS[key]
        is_focus = (focus == key)
        head = _t(meta["label"], meta.get("label_zh"))
        focus_tag = f' {_ui("focus")}' if is_focus else ""
        cards.append(
            f'<div class="sg-card{" focus" if is_focus else ""}" '
            f'style="border-color:{meta["color"]}">'
            f'<div class="sg-head" style="color:{meta["color"]}">{head}{focus_tag}</div>'
            f'<div class="sg-body">{_t(text, text_zh)}</div></div>'
        )
    parts.append(f'<div class="sg-grid">{"".join(cards)}</div>')

    corrections = narrative.get("attribution_corrections") or []
    corrections_zh = narrative.get("attribution_corrections_zh") or []
    if corrections:
        items = "".join(
            f"<li>{_t(c, corrections_zh[i] if i < len(corrections_zh) else None)}</li>"
            for i, c in enumerate(corrections)
        )
        parts.append(
            f'<div class="corrections"><b>{_ui("corrections_title")}</b>'
            f'<ul>{items}</ul></div>'
        )
    return "".join(parts)


def _case_card(case) -> str:
    color, label_en, label_zh = STATE_BADGE.get(case.analysis_state, STATE_BADGE["PENDING"])
    a = case.analysis or {}
    head_bits = [
        f'<span class="cid">#{_esc(case.case_id)}</span>',
        f'<span class="state" style="background:{color}">{_t(label_en, label_zh)}</span>',
    ]
    if case.error_type:
        head_bits.append(f'<span class="etype">{_esc(case.error_type)}</span>')
    if case.db_id:
        head_bits.append(f'<span class="db">{_esc(case.db_id)}</span>')
    if case.failure_category:
        meta = CATEGORIES.get(case.failure_category) or {}
        head_bits.append(
            f'<span class="tag" style="background:{category_color(case.failure_category)}">'
            f'{_t(meta.get("label", case.failure_category), meta.get("label_zh"))}</span>'
        )
    if case.attribution:
        meta = ATTRIBUTIONS.get(case.attribution) or {}
        head_bits.append(
            f'<span class="tag attr" style="background:{attribution_color(case.attribution)}">'
            f'{_t(meta.get("label", case.attribution), meta.get("label_zh"))}</span>'
        )
    failed_phase = str((a.get("failed_phase") or "")).strip().lower()
    if failed_phase in ("phase1", "phase2"):
        phase_label = {"phase1": ("Phase 1", "阶段 1"), "phase2": ("Phase 2", "阶段 2")}[failed_phase]
        head_bits.append(
            f'<span class="tag phase" style="background:#6b46c1">'
            f'{_t(phase_label[0], phase_label[1])}</span>'
        )

    body = []
    if case.correction:
        body.append(
            f'<div class="correction-banner">{_ui("corrected_banner")} '
            f'{_t(case.correction, case.correction_zh)}</div>'
        )
    if case.question:
        body.append(f'<div class="q">{_esc(case.question)}</div>')

    if a:
        for field, ui_key in (("summary", "field_summary"), ("root_cause", "field_root_cause"),
                              ("evidence", "field_evidence"), ("fix_suggestion", "field_fix")):
            val = a.get(field)
            if val and str(val).strip().lower() != "n/a":
                body.append(
                    f'<div class="fa"><b>{_ui(ui_key)}:</b> '
                    f'{_t(val, a.get(field + "_zh"))}</div>'
                )
        conf = a.get("confidence")
        if conf:
            body.append(f'<div class="conf">{_ui("confidence")}: {_esc(conf)}</div>')
    elif case.analysis_state == "FAILED":
        err = (case.status or {}).get("error") or (case.status or {}).get("stderr_tail") or "unknown error"
        body.append(f'<div class="fa err"><b>{_ui("analysis_error")}:</b> {_esc(err)}</div>')
    elif case.analysis_state == "RUNNING":
        body.append(f'<div class="fa muted">{_ui("analyzing")}</div>')
    else:
        body.append(f'<div class="fa muted">{_ui("no_analysis")}</div>')

    sql = []
    if case.predicted_sql:
        sql.append(f'<div class="sql"><b>{_ui("predicted")}</b><pre>{_esc(case.predicted_sql)}</pre></div>')
    if case.gold_sql:
        sql.append(f'<div class="sql gold"><b>{_ui("gold")}</b><pre>{_esc(case.gold_sql)}</pre></div>')
    sql_html = (
        f'<details class="sqlwrap"><summary>{_ui("sql")}</summary>{"".join(sql)}</details>'
        if sql else ""
    )

    data_attrs = (
        f'data-state="{_esc(case.analysis_state)}" '
        f'data-category="{_esc(case.failure_category or "")}" '
        f'data-attribution="{_esc(case.attribution or "")}"'
    )
    return (
        f'<div class="card" {data_attrs}>'
        f'<div class="chead">{"".join(head_bits)}</div>'
        f'<div class="cbody">{"".join(body)}{sql_html}</div></div>'
    )


def render_body(run: RunView) -> str:
    """The inner report body (re-rendered on each live poll)."""
    stats = run.summary.get("stats") if run.summary else aggregate(run)
    narrative = run.summary.get("narrative") if run.summary else None

    header = (
        f'<div class="stats">'
        f'<div class="stat"><span class="k">{_ui("stat_run")}</span><span class="v">{_esc(run.run_id)}</span></div>'
        f'<div class="stat"><span class="k">{_ui("stat_benchmark")}</span><span class="v">{_esc(run.benchmark_id)}</span></div>'
        f'<div class="stat"><span class="k">{_ui("stat_accuracy")}</span><span class="v">'
        f'{_esc(round(run.accuracy, 1) if run.accuracy is not None else "?")}%</span></div>'
        f'<div class="stat"><span class="k">{_ui("stat_failed")}</span><span class="v">{stats["failed_cases"]}</span></div>'
        f'<div class="stat"><span class="k">{_ui("stat_analyzed")}</span><span class="v">'
        f'{stats["analyzed_cases"]} ({stats["coverage_pct"]}%)</span></div>'
        f'</div>'
    )

    agg = (
        f'<section class="panel"><h2>{_ui("panel_issues")}</h2>'
        f'{_bar(stats["by_category"])}{_legend(stats["by_category"])}</section>'
        f'<section class="panel"><h2>{_ui("panel_where")}</h2>'
        f'{_bar(stats["by_attribution"])}{_legend(stats["by_attribution"])}</section>'
        f'<section class="panel wide"><h2>{_ui("panel_suggestions")}</h2>'
        f'{_suggestions_block(narrative)}</section>'
    )

    case_filter = (
        '<div class="case-switcher">'
        f'<label for="case-attribution-switch">{_ui("case_switch_label")}</label>'
        '<select id="case-attribution-switch" data-case-switch data-default="all">'
        f'<option class="t" data-en="{_UI["opt_all"][0]}" data-zh="{_UI["opt_all"][1]}" value="all" selected>{_UI["opt_all"][0]}</option>'
        f'<option class="t" data-en="{_UI["opt_llm"][0]}" data-zh="{_UI["opt_llm"][1]}" value="llm">{_UI["opt_llm"][0]}</option>'
        f'<option class="t" data-en="{_UI["opt_harness"][0]}" data-zh="{_UI["opt_harness"][1]}" value="harness">{_UI["opt_harness"][0]}</option>'
        f'<option class="t" data-en="{_UI["opt_benchmark"][0]}" data-zh="{_UI["opt_benchmark"][1]}" value="benchmark">{_UI["opt_benchmark"][0]}</option>'
        '</select></div>'
    )
    cards = "".join(_case_card(c) for c in run.failed) or f'<p class="muted">{_ui("no_failed")}</p>'
    cases = (
        f'<section class="cases"><h2>{_t("Failed cases", "失败案例")} ({len(run.failed)})</h2>'
        f'{case_filter}{cards}</section>'
    )

    return f'<div id="report">{header}{agg}{cases}</div>'


_CSS = """
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f1f5f9;color:#0f172a}
header.top{background:#0f172a;color:#fff;padding:14px 22px;font-weight:600;font-size:16px;display:flex;justify-content:space-between;align-items:center}
header.top .top-right{display:flex;align-items:center;gap:12px}
header.top .live{font-size:12px;font-weight:400;opacity:.8}
#lang-toggle{background:#1e293b;color:#fff;border:1px solid #334155;border-radius:7px;padding:5px 12px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
#lang-toggle:hover{background:#334155}
main{max-width:1100px;margin:0 auto;padding:18px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.stat{background:#fff;border-radius:8px;padding:8px 14px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.stat .k{display:block;font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:.04em}
.stat .v{font-size:18px;font-weight:600}
.panel{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.panel h2,.cases h2{margin:0 0 10px;font-size:14px;color:#334155}
.bar{display:flex;height:18px;border-radius:6px;overflow:hidden;background:#e2e8f0;margin-bottom:8px}
.bar.empty{align-items:center;justify-content:center;color:#94a3b8;font-size:12px}
.bar .seg{height:100%}
.legend{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px 16px}
.legend li{display:flex;align-items:center;gap:6px;font-size:12px}
.legend .dot{width:10px;height:10px;border-radius:50%}
.legend .lg-num{color:#64748b}
.overall{font-size:14px;margin:0 0 10px}
.findings{margin:0 0 12px;padding-left:18px;color:#334155}
.sg-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.sg-card{border:2px solid;border-radius:8px;padding:10px;background:#f8fafc}
.sg-card.focus{background:#fffbeb}
.sg-head{font-weight:700;font-size:12px;text-transform:uppercase;margin-bottom:6px}
.sg-body{font-size:13px;color:#1e293b}
.corrections{margin-top:10px;padding:8px 10px;background:#fef9c3;border-radius:8px;font-size:13px}
.corrections ul{margin:4px 0 0;padding-left:18px}
.cases h2{margin-top:6px}
.case-switcher{display:flex;align-items:center;gap:10px;margin:0 0 12px}
.case-switcher label{font-size:12px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:.04em}
.case-switcher select{border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;background:#fff;color:#0f172a;font:inherit}
.card{background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:10px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.card[hidden]{display:none}
.chead{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}
.cid{font-weight:700}
.state,.etype,.db,.tag{font-size:11px;border-radius:5px;padding:1px 7px;color:#fff}
.etype{background:#475569}.db{background:#0ea5e9}
.tag{font-weight:600}
.correction-banner{background:#fef9c3;border-left:4px solid #ca8a04;padding:8px 10px;border-radius:6px;margin:4px 0 8px;font-size:13px;color:#713f12}
.q{font-style:italic;color:#334155;margin:4px 0 8px}
.fa{margin:3px 0}.fa.err{color:#b91c1c}.fa.muted,.muted{color:#94a3b8}
.conf{font-size:11px;color:#64748b;margin-top:4px}
.sqlwrap{margin-top:8px}
.sqlwrap summary{cursor:pointer;color:#475569;font-size:12px}
.sql{margin-top:6px}.sql b{font-size:11px;color:#64748b}
.sql pre{background:#0f172a;color:#e2e8f0;padding:8px;border-radius:6px;overflow:auto;font-size:12px;margin:2px 0}
.sql.gold pre{background:#052e16}
@media(max-width:720px){.sg-grid{grid-template-columns:1fr}.case-switcher{align-items:flex-start;flex-direction:column}}
"""

# Language toggle: every translatable node carries data-en/data-zh; the toggle
# swaps textContent (and the bar tooltips' title attr). English is the baseline,
# so a no-JS view stays English. Choice is persisted in localStorage and shared
# across the live poller's re-renders via window.__faLang.
_LANG_JS = """
<script>
function applyLang(lang){
  document.querySelectorAll('.t').forEach(function(el){
    var v = el.dataset[lang];
    el.textContent = (v != null && v !== '') ? v : el.dataset.en;
  });
  document.querySelectorAll('[data-title-en]').forEach(function(el){
    el.setAttribute('title', lang === 'zh' ? el.dataset.titleZh : el.dataset.titleEn);
  });
  document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
  var btn = document.getElementById('lang-toggle');
  if(btn) btn.textContent = lang === 'zh' ? 'EN' : '中文';
  try{ localStorage.setItem('fa_lang', lang); }catch(e){}
  window.__faLang = lang;
}
function currentLang(){
  if(window.__faLang) return window.__faLang;
  try{ return localStorage.getItem('fa_lang') || 'en'; }catch(e){ return 'en'; }
}
function toggleLang(){ applyLang(currentLang() === 'zh' ? 'en' : 'zh'); }
applyLang(currentLang());
</script>
"""

_SWITCH_JS = """
<script>
function initCaseSwitch(root){
  const scope = root || document;
  const select = scope.querySelector('[data-case-switch]');
  if(!select) return;
  const cards = Array.from(scope.querySelectorAll('.cases .card'));
  const apply = (value) => {
    cards.forEach((card) => {
      const attr = card.getAttribute('data-attribution') || '';
      card.hidden = value !== 'all' && attr !== value;
    });
  };
  apply(select.value || select.dataset.default || 'all');
  if(select.dataset.bound === '1') return;
  select.addEventListener('change', () => apply(select.value));
  select.dataset.bound = '1';
}
initCaseSwitch(document);
</script>
"""

_LIVE_JS = """
<script>
async function poll(){
  try{
    const r = await fetch('/api/state');
    if(!r.ok) return;
    const html = await r.text();
    const cur = document.getElementById('report');
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    const next = tmp.querySelector('#report');
    if(next && cur){
      cur.replaceWith(next);
      initCaseSwitch(document);
      applyLang(currentLang());
    }
  }catch(e){}
}
setInterval(poll, 3000);
</script>
"""


def build_html(run_dir: str | Path, *, live: bool = False) -> str:
    run = load_run(run_dir)
    body = render_body(run)
    live_tag = f'<span class="live">{_ui("live")}</span>' if live else ""
    toggle = '<button id="lang-toggle" type="button" onclick="toggleLang()">中文</button>'
    # _LANG_JS must run AFTER _SWITCH_JS defines nothing it needs, but BEFORE
    # _LIVE_JS (whose poller calls applyLang/currentLang). Order: switch, lang, live.
    scripts = _SWITCH_JS + _LANG_JS + (_LIVE_JS if live else "")
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>Failure report · {_esc(run.run_id)}</title>"
        f"<style>{_CSS}</style></head><body>"
        f"<header class='top'><span>{_ui('app_title')}</span>"
        f"<span class='top-right'>{live_tag}{toggle}</span></header>"
        f"<main>{body}</main>{scripts}</body></html>"
    )


def render_body_html(run_dir: str | Path) -> str:
    """Just the #report fragment — what the live poller swaps in."""
    return render_body(load_run(run_dir))
