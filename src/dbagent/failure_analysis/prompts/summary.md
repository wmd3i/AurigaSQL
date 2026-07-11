# Run-Level Failure Summary

You are given a JSON digest of the per-case failure analyses for ONE benchmark
run of a text-to-SQL agent, plus the deterministic distributions already
computed (counts and percentages by failure category and by attribution).

Your job: synthesize the run-level story and write actionable suggestions,
attributed to the THREE top-level variables. Write a single JSON object.

## Output JSON schema

Write a file containing ONLY this JSON object (no prose, no code fences):

```json
{
  "overall_summary": "<=4 sentences: the dominant failure modes and where the effort should go>",
  "key_findings": [
    "<short bullet: a typical issue + its rough share, citing the category>",
    "..."
  ],
  "suggestions": {
    "llm":       "<=3 sentences: concrete prompt/model changes, or 'n/a' if the LLM is not the main driver>",
    "harness":   "<=3 sentences: ALWAYS write a concrete, actionable harness change (a tool, the agent's system prompt in sql_agent.py, or the evaluator/normalization in results/) that would reduce this run's failures. Never 'n/a' — even llm- or benchmark-attributed failures translate into a harness lever (better prompting, a new tool, or evaluator normalization). Cite file.py:function where possible.>",
    "benchmark": "<=3 sentences: concrete changes to the benchmark code/gold/dataset, citing file/path where possible, or 'n/a'>"
  },
  "recommended_focus": "llm | harness | benchmark",
  "attribution_corrections": [
    "<optional: cases whose per-case attribution the source code contradicts, e.g. 'case 12 tagged llm but dbtools.py truncates schema -> harness'. Omit or [] if none.>"
  ],
  "overall_summary_zh": "<Simplified-Chinese translation of `overall_summary`>",
  "key_findings_zh": [
    "<Simplified-Chinese translation of key_findings[0]>",
    "..."
  ],
  "suggestions_zh": {
    "llm":       "<Simplified-Chinese translation of suggestions.llm>",
    "harness":   "<Simplified-Chinese translation of suggestions.harness>",
    "benchmark": "<Simplified-Chinese translation of suggestions.benchmark>"
  },
  "attribution_corrections_zh": [
    "<Simplified-Chinese translation of attribution_corrections[0]>",
    "..."
  ]
}
```

## Bilingual output (the `_zh` fields)

The report is shown in both English and Chinese. After writing the English
fields, add a faithful **Simplified-Chinese** translation in the matching `*_zh`
field/array. Rules:

- **Write idiomatic, native-sounding Chinese (地道的中文).** Do NOT produce
  "translation-ese" — the `_zh` text must read as if originally written by a
  native Chinese speaker. Use natural Chinese sentence structures, authentic
  technical terms, and the active voice where Chinese prefers it. Avoid
  English-calque word order and unnecessary 的/地/被 passives. The translation
  should be equally terse as the English — no padding.
- `key_findings_zh`, `suggestions_zh`, and `attribution_corrections_zh` must be
  **parallel** to their English counterparts: same number of items, same order
  (the viewer matches by index). If `attribution_corrections` is `[]`, make
  `attribution_corrections_zh` `[]` too.
- Keep code/SQL identifiers, table/column names, file paths (e.g.
  `sql_agent.py:run`), tool names, category keys, percentages, and the
  `flag for exclusion:` prefix **verbatim**. Only the surrounding prose is Chinese.
- `recommended_focus` stays an English key (the viewer localizes it).

## Reading the source code (for `harness` and `benchmark` suggestions)

The per-case analyses attributed each failure to `llm` / `harness` / `benchmark`
from *observed behavior only* — they did NOT read the framework source. Your job
is to make the `harness` and `benchmark` suggestions **code-grounded**:

- If `harness` has any meaningful share, READ the relevant harness source under
  the path given in the prompt (`harness_root`, typically `src/dbagent/` — look
  especially at `agents/` for SQL extraction & tools, `runners/` for the loop &
  execution, `results/` for evaluation/normalization). Make the `harness`
  suggestion point at a specific `file.py:function` and the concrete change.
- If `benchmark` has any meaningful share, READ the benchmark source/gold under
  `benchmark_root` (typically `src/dbagent/benchmarks/`) to ground the
  `benchmark` suggestion (e.g. which evaluator step or gold convention is at
  fault).
- The `llm` suggestion is about prompting/model and needs no source reading.

While reading source, if the code **contradicts** a per-case attribution (e.g. a
case tagged `llm` is actually caused by a harness bug you can see in the code),
record it in `attribution_corrections` and let it adjust `recommended_focus`.

Do not modify any source files — read only.

## Rules

1. Ground every claim in BOTH the supplied digest (cite category names and the
   percentages you were given — do not invent numbers) AND, for harness/benchmark,
   the source code you read (cite file/function).
2. `recommended_focus` is the single area with the highest expected payoff
   (usually, but not always, the largest attribution bucket — weigh how fixable
   each is, informed by what you saw in the source).
3. Each `suggestions` entry must be concrete and specific to this run's evidence.
   `llm` and `benchmark` may be `"n/a"` if that area has few or no cases. The
   `harness` suggestion is the actionable channel — we can change harness code but
   not the model weights or the gold dataset — so it must ALWAYS be a concrete
   change, never `"n/a"`. Translate llm-attributed failures into prompting/tooling
   and benchmark-attributed failures into evaluator normalization or surfacing the
   unstated convention (or `flag for exclusion` if the gold is genuinely broken).
4. Keep within the length caps. Be terse and specific.
5. **Spider2-DBT max-steps attribution correction.** When the benchmark is
   Spider2-DBT and a large share of cases are tagged `runtime_or_infra` +
   `harness`, check whether these are actually max-steps exhaustion cases: the
   agent hit the step limit, returned an empty answer, and the harness fell back
   to the workspace's existing `.duckdb` file (which is intentional — see
   `benchmark.py:_infer_workspace_artifact`). If so, these cases are
   **misattributed**: the harness worked as designed; the real failure is that the
   model didn't finish its dbt work within the step budget. Record each such case
   in `attribution_corrections` (e.g. "case X tagged runtime_or_infra/harness but
   sql_agent.py:run returns empty on max_steps and benchmark.py intentionally
   infers the workspace .duckdb — this is an LLM step-budget failure, not a
   harness bug"). Adjust `recommended_focus` and the `harness` suggestion
   accordingly: the fix is prompt-level step-budget awareness, not changing the
   artifact-resolution path.

## Input

The prompt gives you file paths to read:
- `stats` + `cases` digest JSON — `stats` has the deterministic distributions
  (`by_category`, `by_attribution`, `by_error_type`, percentages, totals);
  `cases` is a compact list, one entry per analyzed failure
  `{case_id, failure_category, attribution, summary, fix_suggestion}`.
- `harness_root` / `benchmark_root` — directories to read for code grounding
  (only when harness/benchmark have a meaningful share).

Read the digest (and the source as needed) and write your summary.
