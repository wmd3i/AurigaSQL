# Single-Case SQL Success Analysis

You are analyzing ONE **passing** case from a text-to-SQL agent benchmark (BIRD,
Spider2, or BIRD-Interact). The agent was asked a natural-language question,
inspected a database with SQL tools (and, in interactive benchmarks, could call
`ask()` for clarification), and produced a final answer that MATCHED the gold.

Your job is the mirror image of failure analysis, and its **primary purpose is
harness optimization**: mine this win for a concrete change we can make to the
dbAgent harness (`src/dbagent/`) so that *failing* cases reproduce the same
winning behavior. Measuring **how much the success depended on outside guidance**
(the user/simulator `ask()` channel) is a supporting signal — it tells us whether
the win is a reproducible harness lever or something the agent only managed
because it was handed a clarification. Always land on a harness lever.

## Output JSON schema

Write a file containing ONLY this JSON object (no prose, no code fences, no
commentary before or after):

```json
{
  "case_id":             "<copy from the prompt>",
  "success_pattern":     "<one of the allowed success-pattern keys below>",
  "guidance_dependency": "<one of: none | low | high>",
  "primary_driver":      "<one of: agent | user_guidance | harness | benchmark>",
  "harness_lever":       "<one of: prompt | tool | evaluator | none — WHICH part of src/dbagent we'd change to reproduce this win>",
  "summary":             "<=2 sentences: what the agent did that worked, in plain language",
  "winning_move":        "<=3 sentences explaining the DECISIVE action that produced the correct result, citing evidence (a trajectory step #, a tool name, an ask() clarification, or the specific SQL clause)>",
  "evidence":            "<the specific correct SQL clause / tool call / clarification / execution match that clinched the answer>",
  "transferable_lesson": "<=2 sentences, THE MAIN OUTPUT: the concrete change TO THE dbAgent HARNESS (the agent's system prompt in sql_agent.py, a tool under agents/, or the evaluator/normalization in results/) that would let SIMILAR FAILING cases reproduce this winning behavior. Cite file.py:function where you can. Must be implementable in src/dbagent — never 'use a stronger model'>",
  "confidence":          "high | medium | low",
  "summary_zh":             "<Simplified-Chinese translation of `summary`>",
  "winning_move_zh":        "<Simplified-Chinese translation of `winning_move`>",
  "evidence_zh":            "<Simplified-Chinese translation of `evidence`>",
  "transferable_lesson_zh": "<Simplified-Chinese translation of `transferable_lesson`>"
}
```

Do NOT include any `_`-prefixed fields — the runner adds metadata after you return.

## Bilingual output (the `_zh` fields)

The report is shown in both English and Chinese. After writing the four prose
fields (`summary`, `winning_move`, `evidence`, `transferable_lesson`), also write
a faithful **Simplified-Chinese** translation of each into the matching `*_zh`
field. Rules:

- **Write idiomatic, native-sounding Chinese (地道的中文).** Do NOT produce
  "translation-ese" — the `_zh` text must read as if originally written by a
  native Chinese speaker. Avoid English-calque word order and unnecessary
  的/地/被 passives. Keep it as terse as the English.
- Keep code/SQL identifiers, table/column names, file paths, tool names, step
  numbers **verbatim** (do not translate). Only the surrounding prose is Chinese.
- The `*_zh` text must say the same thing as its English counterpart — no new
  claims, no omissions.
- `success_pattern`, `guidance_dependency`, `primary_driver`, `harness_lever`,
  and `confidence` stay as the English keys (the viewer localizes those).

## Allowed `success_pattern` keys

Pick the SINGLE most decisive good practice:

- `schema_grounding` — inspected the real schema/tables/columns before writing
  SQL instead of guessing, and used the correct identifiers.
- `clarified_ambiguity` — used `ask()` (or the evidence/knowledge base) to
  resolve an ambiguous metric, grouping dimension, filter definition, or sort
  direction before finalizing.
- `iterative_validation` — ran/validated the query, read the results or errors,
  and revised until correct (a working edit-run-verify loop).
- `precise_logic` — got the aggregation/filter/ordering logic exactly right for
  the question's intent.
- `correct_joins` — chose the right tables, join keys, and relationships,
  producing the correct row set.
- `knowledge_use` — correctly applied a knowledge-base entry or column meaning
  that a naive reading of the schema would have missed.
- `careful_output` — matched the required result shape/values without
  over-formatting (no display-only ROUND/cast that would break value matching).
- `other` — does not fit the above.

## `guidance_dependency` — how much did success hinge on OUTSIDE guidance

"Guidance" means information the agent got from the **user/simulator `ask()`
channel** (interactive benchmarks) — a clarification it did not and could not
derive on its own. This is a SUPPORTING signal for harness optimization: a `high`
win is not a reproducible agent skill, so its harness lever must be about teaching
the agent to reach the same conclusion *without* being told. Decide:

- `none` — the agent succeeded purely from its own reasoning over the question,
  schema, evidence, and DB feedback. It made no `ask()` call, or any `ask()` it
  made was not what tipped the outcome.
- `low` — the agent used a clarification, but the same answer was reachable from
  the question/evidence/schema alone; the guidance saved time but was not
  decisive.
- `high` — success clearly hinged on the clarification. Without the `ask()`
  answer the agent would most likely have picked the wrong column/metric/grouping
  and failed.

For non-interactive benchmarks (BIRD dev, Spider2) with no `ask()` channel,
`guidance_dependency` is `none`.

## `primary_driver` — what deserves the credit (pick exactly one)

- `agent` — the model's own good reasoning/tool use produced the correct SQL.
- `user_guidance` — a decisive `ask()` clarification from the user/simulator.
- `harness` — a dbAgent tool/prompt/evaluator behavior made the win possible
  (e.g. a validation tool caught an error the agent then fixed, or evaluator
  normalization accepted a semantically-correct-but-differently-shaped result).
- `benchmark` — the case was easy/underspecified enough that almost any
  reasonable query passes (note this so it is not over-credited).

## `harness_lever` — WHICH part of the harness this win optimizes (pick one)

This is the field that drives harness optimization. Decide which part of
`src/dbagent/` we would change so failing cases reproduce this win:

- `prompt` — a change to the agent's system prompt (e.g. `sql_agent.py`): a rule,
  a checklist item, an ambiguity-resolution step, a step-budget reminder.
- `tool` — a change/addition to the agent tools under `agents/` (e.g. a schema
  inspector, a validate/dry-run tool, an ambiguity-surfacing helper).
- `evaluator` — a change to scoring/normalization in `results/` or the
  benchmark's evaluator that would fairly credit the same correct behavior.
- `none` — the win teaches us nothing actionable about the harness (e.g. the case
  was trivially easy, or success hinged purely on `ask()` guidance we cannot
  replicate); `transferable_lesson` should say so plainly.

Prefer `prompt` or `tool` for `guidance_dependency: high` wins — the lever is to
make the agent self-detect the ambiguity, since guidance is absent in
non-interactive runs.

## Rules

1. Every claim in `winning_move` and `evidence` must cite something concrete: a
   trajectory step number, a tool name, an `ask()` clarification, or the specific
   SQL clause / execution match. Do not speculate about model internals.
2. Pick the SINGLE most decisive `success_pattern`.
3. `transferable_lesson` is THE PRIMARY OUTPUT and must be a change WE can make in
   `src/dbagent` — the agent's prompt, a tool, or the evaluator — that would help
   *failing* cases reproduce this win. It must be consistent with `harness_lever`.
   Cite `file.py:function` where you can. Never "use a stronger/different model".
   If the win was a decisive `ask()`, the lesson is usually a prompt change that
   teaches the agent *when/how* to ask or to self-resolve the ambiguity.
4. If `guidance_dependency` is `high`, `transferable_lesson` must explain how to
   make the agent recognize the SAME ambiguity on its own next time
   (prompt/tool), since the guidance won't always be available.
5. Set `harness_lever: none` ONLY when there is genuinely no actionable harness
   change; do not use it as a lazy default.
6. Keep each field within its length cap. Be specific and terse.

## How to read the inputs

You are given file paths on disk. Read them with your tools.

- **case result JSON** — the authoritative outcome. Contains `input.question`,
  `input.evidence`, `input.db_id`, and `evaluation` (mode, match flags, and the
  prediction vs reference). Read `evaluation.mode` FIRST to know how the case was
  scored (SQL result match vs artifact/file match).
- **trajectory JSON** — the full chat trajectory: a list of messages with
  `role`, `content`, and `tool_calls` (each with `function.name` and
  `function.arguments`). Step numbers are list indices. Use it to find the
  decisive move and any `ask()` clarification.
- Ground the analysis in the provided source snapshot when proposing the
  `transferable_lesson`; prefer concrete file/function references over generic
  speculation.

Start from `evaluation.mode` and the trajectory's decisive steps. Explain *why*
the agent produced the correct query/artifact, then turn that into a lesson for
the failing cases.
