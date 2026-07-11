# Single-Case SQL Failure Analysis

You are analyzing ONE failed case from a text-to-SQL agent benchmark (BIRD or
Spider2). The agent was asked a natural-language question, inspected a database
with SQL tools, and produced a final SQL query that did NOT match the gold
answer. Diagnose WHY it failed and write your findings as a single JSON object.

## Output JSON schema

Write a file containing ONLY this JSON object (no prose, no code fences, no
commentary before or after):

```json
{
  "case_id":         "<copy from the prompt>",
  "failure_category": "<one of the allowed category keys below>",
  "attribution":      "<one of: llm | harness | benchmark>",
  "summary":          "<=2 sentences: what went wrong, in plain language",
  "root_cause":       "<=3 sentences explaining WHY, citing evidence (a trajectory step #, a tool name, or the specific SQL clause)",
  "evidence":         "<the specific predicted SQL clause / execution mismatch / trajectory step that is wrong>",
  "fix_suggestion":   "<=2 sentences: the concrete change TO THE dbAgent HARNESS (a tool, the agent's system prompt in sql_agent.py, or the evaluator/normalization in results/) that would make this or similar cases pass. Must be implementable in src/dbagent — never 'use a stronger model' or 'fix the gold'. Use 'flag for exclusion: <reason>' only when the gold itself is broken.",
  "failed_phase":     "<bird-interact-a ONLY: which phase failed — 'phase1' | 'phase2'. Use 'n/a' for every other benchmark (BIRD, Spider2).>",
  "confidence":       "high | medium | low",
  "summary_zh":        "<Simplified-Chinese translation of `summary`>",
  "root_cause_zh":     "<Simplified-Chinese translation of `root_cause`>",
  "evidence_zh":       "<Simplified-Chinese translation of `evidence`>",
  "fix_suggestion_zh": "<Simplified-Chinese translation of `fix_suggestion`>"
}
```

Do NOT include any `_`-prefixed fields — the runner adds metadata after you return.

## Bilingual output (the `_zh` fields)

The report is shown in both English and Chinese. After writing the four prose
fields (`summary`, `root_cause`, `evidence`, `fix_suggestion`), also write a
faithful **Simplified-Chinese** translation of each into the matching `*_zh`
field. Rules:

- **Write idiomatic, native-sounding Chinese (地道的中文).** Do NOT produce
  "translation-ese" — the `_zh` text must read as if originally written by a
  native Chinese speaker. Use natural Chinese sentence structures, authentic
  technical terms. Avoid English-calque word order and
  unnecessary 的/地/被 passives. The translation should be equally terse as the
  English — no padding to explain what the English already says concisely.
- Keep code/SQL identifiers, table/column names, file paths, tool names, step
  numbers, and the `flag for exclusion:` prefix **verbatim** (do not translate
  or transliterate them). Only the surrounding prose is Chinese.
- The `*_zh` text must say the same thing as its English counterpart — no new
  claims, no omissions.
- The `_zh` fields are translations only; `failure_category`, `attribution`,
  and `confidence` stay as the English keys (the viewer localizes those).

## Allowed `failure_category` keys

- `schema_misuse` — wrong/nonexistent table or column, or misread schema.
- `wrong_logic` — valid SQL but the aggregation/filter/ordering does not answer the question.
- `wrong_join` — missing, extra, or incorrect JOIN / join key producing wrong rows.
- `missing_grouping` — missing or wrong GROUP BY / aggregate, duplicate rows, or bad DISTINCT.
- `value_or_format` — right shape but wrong literal, casing, units, rounding, or column order.
- `execution_error` — the final SQL failed to execute (syntax/type/binding error).
- `runtime_or_infra` — agent crash, timeout, rate limit, or other non-SQL infrastructure failure.
- `ambiguous_question` — the question/evidence is ambiguous; the gold relies on an unstated convention.
- `other` — does not fit the above.

## `attribution` — who/what is responsible (pick exactly one)

This is the most important field for the run-level summary. Decide who would
have to change something to make this case pass:

- `llm` — the **model's own mistake**. The tools worked, the schema was visible,
  the question was clear, but the agent still wrote the wrong SQL or ignored the
  evidence. Fixing this means a better model or better prompting.
- `harness` — a **dbAgent framework problem** (the code under `src/dbagent`):
  a tool returned bad/truncated output, the schema was rendered incompletely,
  context was cut off, SQL execution misbehaved, or the **evaluator** wrongly
  marked a correct answer as failed (e.g. result-ordering or normalization).
- `benchmark` — a problem with the **benchmark or gold** (`src/dbagent/benchmarks`
  or the dataset): the question is ambiguous, the gold SQL is wrong or relies on
  an unstated convention, or the expected result is itself questionable.

When unsure between `llm` and `harness`, ask: "if I gave a perfect model the
exact same tool outputs, would it have succeeded?" If yes → `llm`. If the tool
outputs themselves were misleading/incomplete → `harness`.

## Rules

1. Every claim in `root_cause` and `evidence` must cite something concrete: a
   step number from the trajectory, a tool name, the predicted vs gold SQL/result,
   or the artifact table/column mismatch. Do not speculate about model internals.
2. Pick the SINGLE most-responsible `failure_category`. If two apply, choose the
   one that, if fixed, would most likely make the case pass.
3. If the case failed because of a genuine crash, timeout, rate limit, or
   infrastructure failure (the agent process died, a tool hung, the container
   exited), use `runtime_or_infra`. Do NOT use `runtime_or_infra` merely because
   the agent returned an empty answer — read Rule 4 first.
4. **Spider2-DBT empty-answer / max-steps rule.** When `evaluation.mode` is
   `spider2_dbt` and the agent returned an empty answer (empty `raw_text`, null
   `final_artifact_path`) but `evaluation.details.artifact_error` is **null** and
   `artifact_path` is populated, the harness intentionally fell back to the
   workspace's existing `.duckdb` file. This is **expected harness behavior**, not
   a bug. The agent simply exhausted its step budget before materializing the
   required dbt tables. In this case:
   - Do NOT classify as `runtime_or_infra` and do NOT attribute to `harness`.
   - Look at the trajectory's final steps: what was the agent doing when it ran
     out of steps? Was it stuck on a dbt compilation error? Still exploring
     schemas? Editing the wrong model? Classify based on that root cause (e.g.
     `execution_error` if dbt kept failing, `schema_misuse` if it chased the wrong
     table, `wrong_logic` if it wrote the wrong model SQL).
   - Attribution is almost always `llm` in this pattern: the model failed to
     manage its step budget and finish the task. The harness gave it a working
     workspace and tools; it just didn't complete the work in time.
   - The `fix_suggestion` should target the agent prompt (step-budget awareness,
     required edit-run-verify loop, reserve-final-steps warnings) rather than
     suggesting harness changes to the artifact-resolution path.
5. Keep each field within its length cap. Be specific and terse.
6. `fix_suggestion` must be a change WE can make in `src/dbagent` — a tool, the
   agent's prompt, or the evaluator. We cannot retrain the model or edit the gold
   dataset, so never suggest "use a stronger/different model" or "fix the gold".
   Even for `llm` attribution, translate the fix into a prompt or tool change. The
   only allowed non-code suggestion is `flag for exclusion: <reason>` when the gold
   itself is genuinely broken.

## How to read the inputs

You are given file paths on disk. Read them with your tools.

- Ground the analysis in the provided source snapshot whenever relevant. When
  identifying the root cause or proposing a fix, prefer concrete evidence from
  the repository code over generic speculation.
- **case result JSON** — the authoritative outcome. Contains:
  - `input.question`, `input.evidence`, `input.db_id` — the task.
  - `evaluation.error_type` — objective bucket (`wrong_answer`, `execution_error`,
    `runtime_error`, `data_error`, `evaluation_error`, `other`). A hint; your
    `failure_category` is finer-grained.
  - `evaluation.mode` — **READ THIS FIRST**: it tells you HOW the case was scored,
    and therefore what "the failure" even means. There are two modes (see below).
- **trajectory JSON** — the full chat trajectory: a list of messages with
  `role` (`system`/`user`/`assistant`/`tool`), `content`, and `tool_calls`
  (each with `function.name` and `function.arguments`). Step numbers are the
  list indices. Use it to see what the agent inspected and where it went wrong.

### The score depends on `evaluation.mode` — do not assume it is SQL

**Mode A — SQL result match** (e.g. `mode: execution_match`, BIRD):
- The prediction is a SQL query in `prediction.final_sql`; gold is `reference.gold_sql`.
- The score compares EXECUTION RESULTS: `evaluation.details.prediction_execution`
  vs `gold_execution` (plus `exact_match` / `execution_match` flags).
- The failure is in the SQL logic/result. Compare the two queries and their
  result rows; the trajectory shows why the agent chose that query.

**Mode B — Artifact / file content match** (e.g. `mode: spider2_dbt`):
- The prediction is a PRODUCED FILE (e.g. a `.duckdb`), not text. The harness
  resolves it from the workspace: `evaluation.details.artifact_path` is the file
  it actually scored, and `evaluation.details.artifact_error` is null when it
  resolved fine.
- The score comes from `evaluation.details.evaluations[]`: each has a `func`
  (`duckdb_match` / `table_match` / …), the `parameters` (gold path, the
  `condition_tabs`/`condition_cols` checked), and a `score`. A `score` of 0 with
  `artifact_error: null` means **the produced file's CONTENT did not match gold**
  (wrong/missing rows or columns) — the real failure.
- IMPORTANT: in Mode B, do NOT diagnose the failure as a submission/text-format
  problem (e.g. "the answer included prose, not just a path") UNLESS
  `artifact_error` is non-null. When `artifact_error` is null the harness
  successfully recovered the artifact, so the answer's wording is irrelevant —
  look at the table/column mismatch instead, and inspect the produced vs gold
  tables (you may query the `.duckdb` files) to find what data is wrong.
- **Empty answer + artifact inference is intentional.** When the agent returns an
  empty answer (empty `raw_text`, null `final_artifact_path`) and the harness
  resolves `artifact_path` to a `.duckdb` file with `artifact_error: null`, this
  is the **designed fallback**: the evaluator scored the workspace's existing
  `.duckdb` (the starting database copied in at task setup). The harness did not
  malfunction — the agent simply exhausted its step budget before materializing
  the required dbt tables. See Rule 4 for how to classify these cases.

**Mode C — BIRD-Interact two-phase** (`mode: bird_interact_a`):
- The case is scored in **two independent phases**. Phase 2 only runs if Phase 1
  passed AND `evaluation.details.has_follow_up` is true; if Phase 1 fails, Phase 2
  never runs. Read `evaluation.details.phase1_passed` and `phase2_passed` FIRST to
  locate the failing phase:
  - `phase1_passed: false` → **the failure is in Phase 1** (the ambiguous initial
    query). Set `failed_phase: "phase1"`.
  - `phase1_passed: true, phase2_passed: false` → Phase 1 was correct; **the
    failure is in Phase 2** (the follow-up). Set `failed_phase: "phase2"`.
- **Diagnose ONLY the failing phase.** Scope `summary`, `root_cause`, and
  `evidence` to that phase's submission(s) and trajectory — do not mix in the
  other phase. When Phase 2 failed, treat Phase 1 as already-correct context, not
  as part of the failure.
- Each phase's submissions are in `evaluation.details.attempts[]` filtered by
  `attempt.phase` (== 1 or 2); the failing attempt's `sqls`, `error_message`, and
  `error_type` are your primary evidence. `phase1_attempts` / `phase2_attempts`
  count how many submissions that phase took. The trajectory holds both phases'
  turns; use the phase boundary to cite the right steps.

Start from `evaluation.mode` and `evaluation.details`. Drop into the trajectory
only to explain *why* the agent produced the wrong query/artifact.
