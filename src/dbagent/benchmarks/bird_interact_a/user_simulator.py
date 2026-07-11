"""BIRD-Interact user simulator for the ``ask`` action (host-side).

Replicates the original ``UserSimulatorBirdInteractEnv`` clarification path from
``bird_interact_agent``: when the agent asks a clarifying question, the simulator
(1) classifies it against the *labeled* ambiguity points / ground-truth SQL
(``encode_ambiguity``) and (2) generates a constrained natural-language answer
that must not leak the reference SQL (``decode_response``).

This runs **host-side only**. The ground truth it needs (clear query, reference
SQL, ambiguity annotations) must never enter the agent's container; the container
reaches the simulator over the file channel in ``runners.ipc`` carrying only
the agent's question and the constrained answer.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

logger = logging.getLogger(__name__)

# NOTE: the official BIRD-Interact-ADK user simulator returns the clarification
# answer verbatim (no character clamp) and even guards against truncation
# (orchestrator/test_harness.py: "ask_user_not_truncated"). The old non-ADK env
# had a 400-char clamp, but it applied only to the simulator's own
# dialogue_history copy, not to the reply handed back to the agent. This port is
# stateless (no dialogue_history), so it keeps no clamp at all.

# ── Encoder / decoder prompts (ported from BIRD-Interact-ADK
# user_simulator/prompts.py, v2: usersim-guard / recommended prompt) ──

_ENCODER_PROMPT = """You are role-playing as a human USER interacting with an AI collaborator to complete a Text-to-SQL task. The AI collaborator may ask one question about this task. Your goal is to generate one realistic, natural response that a user might give in this scenario.

## Input Information:
You will be provided with:
- Task Description: The type of task you are trying to accomplish.
- Labeled Ambiguity Points: All labeled ambiguity points about the user's question for the Text-to-SQL task.
- Ground-truth SQL Segments: All ground-truth SQL segments.
- Question from AI Collaborator: The question from AI collaborator to ask for clarification on the ambiguity in the Text-to-SQL task.

Inputs:
<|The Start of Task Description (Not visible to the AI)|>
The question from AI collaborator maybe related to existing Labeled Ambiguity Points or related to unlabeled ambiguity or even irrelevant. So, you should choose one action at this turn.

Action Choices:
1. **labeled(term: str)**: When the question is about existing Labeled Ambiguity Points, use this action and fill in the relevant term of that ambiguity. Format: **labeled("Amb")**.
2. **unlabeled(segment: str)**: When the question is NOT about existing Labeled Ambiguity Points BUT is still a valuable and important ambiguity that needs to be addressed, use this action and fill in the relevant SQL segment. Format: **unlabeled("ALTER")**.
3. **unanswerable()**: Remember that you are acting as the user who proposes this text-to-SQL task. Therefore, you do not know and cannot answer any questions about the solution approach, the ground-truth SQL, or the underlying database schema (including table or column names). Format: **unanswerable()**.
<|The End of Task Description|>

<|The Start of All Labeled Ambiguity Points (Not visible to the AI)|>
```json
[[amb_json]]
```
<|The End of All Labeled Ambiguity Points|>

<|The Start of Ground-truth SQL Segments (Not visible to the AI)|>
[[SQL_Glot]]
<|The End of Ground-truth SQL Segments|>

<|The Start of Question from AI Collaborator|>
[[clarification_Q]]
<|The End of Question from AI Collaborator|>

## Guidelines:
- You MUST choose only **one action** listed above.
- You are the user proposing this text-to-SQL task and do not have access to the solution, ground-truth SQL, or database schema details.
- If you can do it well, you will get 10 thousand USD bonus!

## Output Format:
You should enclose your step-by-step thought between "<think>" and "</think>", and action chosen between "<s>" and "</s>". Format example:
```
- Thought:
<think>[Step-by-Step Thought]</think>

- Action:
<s>[Your Action]</s>
```

## Your Response:
- Thought:
<think>"""

_DECODER_PROMPT = """You are role-playing as a human USER interacting with an AI collaborator to complete a Text-to-SQL task. The AI collaborator may ask one question about this task. Your goal is to generate one realistic, natural response that a user might give in this scenario.

## Input Information:
You will be provided with:
- Task Description: The type of task you are trying to accomplish.
- DB Schema Information: The detailed DB schema with data examples.
- Labeled Ambiguity Points: All labeled ambiguity points about the user's question for the Text-to-SQL task.
- Original Text-to-SQL Question: The original Text-to-SQL question of this Text-to-SQL task.
- Ground-truth SQL: The whole ground-truth SQL of this Text-to-SQL task.
- Ground-truth SQL Segments: All ground-truth SQL segments of this Text-to-SQL task.
- Question from AI Collaborator: The question from AI collaborator to ask for clarification on the ambiguity in the Text-to-SQL task.
- Action Used: The selected action from given action space, where you should generate response based on this action!

Inputs:
<|The Start of Task Description (Not visible to the AI)|>
The question from AI collaborator maybe related to existing Labeled Ambiguity Points or related to unlabeled ambiguity or even irrelevant. So, one action was chosen at previous turn.

Action Space:
1. **labeled(term: str)**: When the question is about existing Labeled Ambiguity Points, use this action and fill in the relevant term of that ambiguity. Format: **labeled("Amb")**.
2. **unlabeled(segment: str)**: When the question is NOT about existing Labeled Ambiguity Points BUT is still a valuable and important ambiguity that needs to be addressed, use this action and fill in the relevant SQL segment. Format: **unlabeled("ALTER")**.
3. **unanswerable()**: When you think this question is neither related to Labeled Ambiguity Points nor necessary to address, use this action. Format: **unanswerable()**.

Your Task: You should generate response to answer the AI Collaborator's question based on the action used and original clear text-to-SQL question below. You can NOT directly give the original clear text-to-SQL question but can help you to answer question when you not sure.
<|The End of Task Description|>

<|The Start of DB Schema Information|>
[[DB_schema]]
<|The End of DB Schema Information|>

<|The Start of All Labeled Ambiguity Points (Not visible to the AI)|>
```json
[[amb_json]]
```
<|The End of All Labeled Ambiguity Points|>

<|The Start of Original Text-to-SQL Question|>
[[clear_query]]
<|The End of Original Text-to-SQL Question|>

<|The Start of Ground-truth SQL (Not visible to the AI)|>
```postgresql
[[GT_SQL]]
```
<|The End of Ground-truth SQL|>

<|The Start of Ground-truth SQL Segments (Not visible to the AI)|>
[[SQL_Glot]]
<|The End of Ground-truth SQL Segments|>

<|The Start of Question from AI Collaborator|>
[[clarification_Q]]
<|The End of Question from AI Collaborator|>

<|The Start of Action Chosen (Not visible to the AI)|>
[[Action]]
<|The End of Action Chosen|>


## Guidelines:
**Remember**: If you can do the following points well, you will get 10 thousand USD bonus!
1. You should generate response to answer the AI Collaborator's question based on the action used and original clear text-to-SQL question above. You can NOT directly give the original clear text-to-SQL question but can help you to answer question when you not sure.
2. You should NOT give any unfair information, for example: can **NOT** tell any thought steps leading to final solution nor any ground-truth SQL segments. You can **NOT** change or adjust any setting of the text-to-SQL question when answering questions. The response should be concise.
3. You should NOT ask any question.

## Output Format:
Your response must follow the format "<s>[Fill-in-Your-Response]</s>"; for example, if the action is "unanswerable()", you MUST exactly respond: "<s>Sorry, this question is out of scope, so I can not answer your question.</s>".

## Your Response:
<s>"""


def segment_sql(sql: str, dialect: str = "postgres") -> list[tuple[str, str]]:
    """Slice a SQL string into (clause_name, clause_text) segments.

    Ported from ``bird_interact_agent/src/envs/user_simulator/sql_parser.py``.
    Falls back to whole-statement segments on any tokenization error.
    """
    try:
        from sqlglot import tokenize
        from sqlglot.tokens import TokenType

        clause_keywords = {
            TokenType.SELECT: "SELECT",
            TokenType.FROM: "FROM",
            TokenType.WHERE: "WHERE",
            TokenType.HAVING: "HAVING",
            TokenType.GROUP_BY: "GROUP BY",
            TokenType.ORDER_BY: "ORDER BY",
            TokenType.LIMIT: "LIMIT",
            TokenType.OFFSET: "OFFSET",
            TokenType.JOIN: "JOIN",
            TokenType.STRAIGHT_JOIN: "STRAIGHT JOIN",
        }
        starts: list[tuple[int, str]] = []
        for tok in tokenize(sql, read=dialect):
            name = clause_keywords.get(tok.token_type)
            if name:
                starts.append((tok.start, name))
        if not starts:
            return [("STATEMENT", sql.strip())]
        starts.sort(key=lambda x: x[0])
        segments: list[tuple[str, str]] = []
        for idx, (pos, name) in enumerate(starts):
            end = starts[idx + 1][0] if idx + 1 < len(starts) else len(sql)
            segments.append((name, sql[pos:end].strip()))
        return segments
    except Exception:
        parts = [p.strip() for p in sql.split(";")]
        return [
            ("STATEMENT", p if p.endswith(";") else p + ";")
            for p in parts
            if p
        ]


def _extract_tagged(content: str, fallback: str) -> str:
    """Pull the answer out of an <s>...</s> wrapper, leniently.

    The original env primed completions with a trailing ``<s>`` and parsed the
    closing tag. Chat/reasoning models often omit the tags (or emit only one), so
    we strip whatever wrapper is present and fall back to the raw content; only a
    genuinely empty reply uses ``fallback``.
    """
    if "<s>" in content and "</s>" in content:
        return content.split("<s>")[1].split("</s>")[0].strip()
    if "</s>" in content:
        return content.split("</s>")[0].strip()
    if "<s>" in content:
        return content.split("<s>", 1)[1].strip()
    stripped = content.strip()
    return stripped if stripped else fallback


# An LLM caller: ``(messages) -> raw_content``. Injected by the runner (with the
# run's configured max_tokens) so this module stays free of any connector/provider
# dependency and so reasoning models get enough headroom to emit an answer.
LLMCaller = Callable[[list[dict[str, str]]], str]


class UserSimulator:
    """Answer one clarifying question using host-side ground truth.

    ``reference_sql`` may be a single SQL string or a list of statements.
    ``ambiguity`` is the ``{"user_query_ambiguity": ..., "knowledge_ambiguity": ...}``
    block for phase 1, or ``{}`` for phase 2 (which has no labeled ambiguity).
    """

    def __init__(
        self,
        *,
        clear_query: str,
        reference_sql: Any,
        ambiguity: dict[str, Any] | None,
        db_schema: str,
        llm: LLMCaller,
    ) -> None:
        self.clear_query = clear_query or ""
        self.reference_sql = reference_sql
        self.ambiguity = ambiguity or {}
        self.db_schema = db_schema or ""
        self.llm = llm
        self._seg_cache: dict[str, list[tuple[str, str]]] = {}

    def _sql_list(self) -> list[str]:
        if isinstance(self.reference_sql, list):
            return [s for s in self.reference_sql if s]
        return [self.reference_sql] if self.reference_sql else []

    def _segment(self, sql: str) -> list[tuple[str, str]]:
        if sql not in self._seg_cache:
            self._seg_cache[sql] = segment_sql(sql)
        return self._seg_cache[sql]

    def _sql_segments(self) -> str:
        out = ""
        for i, sql in enumerate(self._sql_list()):
            if i > 0:
                out += "\n===\n"
            for clause, text in self._segment(sql):
                out += clause + ":\n" + text + "\n\n"
        return out.strip()

    def _amb_json(self) -> str:
        return json.dumps(self.ambiguity, indent=4)

    def encode_ambiguity(self, question: str) -> str:
        prompt = (
            _ENCODER_PROMPT.replace("[[clarification_Q]]", question)
            .replace("[[amb_json]]", self._amb_json())
            .replace("[[SQL_Glot]]", self._sql_segments())
            .replace("[[DB_schema]]", self.db_schema)
        )
        try:
            content = self.llm([{"role": "user", "content": prompt}]).strip()
            action = _extract_tagged(content, "unanswerable()")
            logger.info("user_simulator_encoded action=%s", action)
            return action
        except Exception:
            logger.warning("user_simulator encode failed", exc_info=True)
            return "unanswerable()"

    def decode_response(self, question: str, action: str) -> str:
        prompt = (
            _DECODER_PROMPT.replace("[[clarification_Q]]", question)
            .replace("[[Action]]", action)
            .replace("[[clear_query]]", self.clear_query)
            .replace("[[amb_json]]", self._amb_json())
            .replace("[[GT_SQL]]", "\n".join(self._sql_list()))
            .replace("[[SQL_Glot]]", self._sql_segments())
            .replace("[[DB_schema]]", self.db_schema)
        )
        try:
            content = self.llm([{"role": "user", "content": prompt}]).strip()
            return _extract_tagged(content, "I'm not sure I understand your question.")
        except Exception:
            logger.warning("user_simulator decode failed", exc_info=True)
            return "I'm not sure I understand your question."

    def answer(self, question: str) -> str:
        action = self.encode_ambiguity(question)
        return self.decode_response(question, action)
