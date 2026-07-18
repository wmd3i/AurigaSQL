/**
 * Split an ask_user clarification into separate questions for the tabbed UI.
 *
 * Heuristic: break after each "?" that is followed by whitespace, then only
 * treat the result as multiple questions if at least two chunks actually
 * contain a "?". This keeps single questions (even ones with a long preamble
 * or an embedded options list) as one tab, and only fans out genuine
 * multi-question prompts like "Which range? Which metric? Group by what?".
 */
export function splitQuestions(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const parts = t
    .split(/(?<=\?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const questionish = parts.filter((p) => p.includes("?"));
  return questionish.length >= 2 ? parts : [t];
}
