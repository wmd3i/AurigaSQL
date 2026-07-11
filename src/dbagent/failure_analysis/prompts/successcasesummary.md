# Run-Level Success Summary

You are given a JSON digest (`dump.json`) of the per-case **success** analyses
for ONE benchmark run of a text-to-SQL agent, plus the deterministic
distributions already computed (counts and percentages by success pattern, by
guidance dependency, by primary driver, and **by harness lever**).

Your job — and the whole point of this analysis — is **harness optimization**:
turn what worked into concrete changes to the dbAgent harness (`src/dbagent/`)
that would make the *failing* cases in this benchmark pass. The `transferable_fixes`
object is the primary deliverable; ground it in the `by_harness_lever` distribution
(which lever has the most reproducible wins) and in the source code. Measuring
**how much success depended on outside guidance** (the user/simulator `ask()`
channel) is a supporting check: guidance-dependent wins are not reproducible
agent skills, so their harness fix must make the agent self-resolve the ambiguity.
Write a single JSON object.

## Output JSON schema

Write a file containing ONLY this JSON object (no prose, no code fences):

```json
{
  "overall_summary": "<=4 sentences: the dominant winning patterns and how reliably the agent reproduces them>",
  "winning_patterns": [
    "<short bullet: a reusable good practice + its rough share, citing the success_pattern key>",
    "..."
  ],
  "transferable_fixes": {
    "prompt":    "<=3 sentences: a concrete change to the agent's system prompt (sql_agent.py) that would teach FAILING cases to reproduce these wins, or 'n/a'>",
    "tools":     "<=3 sentences: a concrete tool change/addition that would surface the winning behavior to failing cases, or 'n/a'>",
    "evaluator": "<=3 sentences: a concrete evaluator/normalization change in results/ that would fairly credit the same correct behavior, or 'n/a'>"
  },
  "guidance_reliance": "<=3 sentences: how much success depended on user/simulator ask() guidance vs the agent's own reasoning, with the rough share (cite the guidance_dependency distribution). Call out cases the agent could NOT have solved without guidance and what that implies for un-guided (non-interactive) runs.>",
  "recommended_focus": "prompt | tools | evaluator",
  "overall_summary_zh": "<Simplified-Chinese translation of `overall_summary`>",
  "winning_patterns_zh": [
    "<Simplified-Chinese translation of winning_patterns[0]>",
    "..."
  ],
  "transferable_fixes_zh": {
    "prompt":    "<Simplified-Chinese translation of transferable_fixes.prompt>",
    "tools":     "<Simplified-Chinese translation of transferable_fixes.tools>",
    "evaluator": "<Simplified-Chinese translation of transferable_fixes.evaluator>"
  },
  "guidance_reliance_zh": "<Simplified-Chinese translation of `guidance_reliance`>"
}
```

## Bilingual output (the `_zh` fields)

The report is shown in both English and Chinese. After writing the English
fields, add a faithful **Simplified-Chinese** translation in the matching `*_zh`
field/array. Rules:

- **Write idiomatic, native-sounding Chinese (地道的中文).** Do NOT produce
  "translation-ese". Avoid English-calque word order and unnecessary 的/地/被
  passives. Keep it as terse as the English.
- `winning_patterns_zh` and the `transferable_fixes_zh` object must be
  **parallel** to their English counterparts: same number of items / same keys,
  same order (the viewer matches by index/key).
- Keep code/SQL identifiers, table/column names, file paths (e.g.
  `sql_agent.py:run`), tool names, success-pattern keys, and percentages
  **verbatim**. Only the surrounding prose is Chinese.
- `recommended_focus` stays an English key (the viewer localizes it).

## Reading the source code (for `transferable_fixes`)

The per-case analyses proposed lessons from *observed behavior only* — they did
NOT read the framework source. Make the `transferable_fixes` **code-grounded**:

- For `prompt`, read the agent's system prompt construction under the path given
  in the prompt (`harness_root`, typically `src/dbagent/agents/`) and point at
  the specific place a rule should be added.
- For `tools`, read the tool set (`agents/`) and name the specific tool to add or
  change.
- For `evaluator`, read `results/` (and `benchmarks/` for scoring) and name the
  normalization/comparison step to adjust.

Do not modify any source files — read only.

## Rules

1. Ground every claim in BOTH the supplied digest (cite success_pattern /
   harness_lever keys and the percentages you were given — do not invent numbers)
   AND, for the fixes, the source code you read (cite file/function).
2. `recommended_focus` is the single lever with the highest expected payoff for
   converting failing cases into passing ones — usually the largest
   `by_harness_lever` bucket, weighed by how implementable it is.
3. Each `transferable_fixes` entry must be concrete and specific to this run's
   evidence; use `"n/a"` only when that lever genuinely does not apply.
4. **Guidance honesty.** If a large share of successes are `guidance_dependency:
   high`, say so plainly in `guidance_reliance`: the agent's un-guided ability is
   weaker than the pass rate suggests, and the priority becomes teaching it to
   detect the ambiguity itself (a `prompt`/`tools` fix), because guidance is
   absent in non-interactive runs.
5. Keep within the length caps. Be terse and specific.

## Input

The prompt gives you file paths to read:
- `dump.json` — the digest: `stats` has the deterministic distributions
  (`by_success_pattern`, `by_guidance_dependency`, `by_primary_driver`,
  `by_harness_lever`, percentages, totals); `cases` is a compact list, one entry
  per analyzed success `{case_id, success_pattern, guidance_dependency,
  primary_driver, harness_lever, summary, transferable_lesson}`.
- `harness_root` — directory to read for code grounding (`src/dbagent/`).

Read the digest (and the source as needed) and write your summary.
