/** Removes trailing backend-only metadata from persisted and legacy agent text. */
export function stripSystemNote(text: string): string {
  return text.replace(/\s*\[SYSTEM NOTE:[^\]]*\]\s*$/g, "").trim();
}
