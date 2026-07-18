from __future__ import annotations

import re
from typing import Any

READONLY_SQL_RE = re.compile(r"^\s*(SELECT|WITH|EXPLAIN)\b", re.IGNORECASE)
MAX_RESULT_WORDS = 500


def ensure_readonly_sql(sql: str) -> tuple[bool, str]:
    sql_cleaned = re.sub(r"--.*$", "", sql, flags=re.MULTILINE)
    sql_cleaned = re.sub(r"/\*.*?\*/", "", sql_cleaned, flags=re.DOTALL)
    if not READONLY_SQL_RE.match(sql_cleaned):
        return False, "Only SELECT, WITH, or EXPLAIN queries are allowed"
    return True, ""


def format_rows(rows: list[tuple[Any, ...]], columns: list[str] | None = None) -> str:
    if not rows:
        return "Query executed, empty result set."
    lines: list[str] = []
    if columns:
        lines.append(" | ".join(columns))
        lines.append("-" * min(len(lines[0]), 200))
    for row in rows[:100]:
        cells = [str(cell)[:100] for cell in row]
        lines.append(" | ".join(cells))
    return _truncate_words("\n".join(lines), MAX_RESULT_WORDS)


def _truncate_words(text: str, max_words: int) -> str:
    visible_lines: list[str] = []
    words_used = 0
    for line in text.splitlines():
        words = line.split()
        if not words:
            visible_lines.append(line)
            continue
        if words_used + len(words) <= max_words:
            visible_lines.append(line)
            words_used += len(words)
            continue
        remaining = max_words - words_used
        if remaining > 0:
            visible_lines.append(" ".join(words[:remaining]) + "...")
        break
    return "\n".join(visible_lines)
