import { describe, expect, it } from "vitest";
import { findExecutedResult } from "./findExecutedResult";
import type { TimelineEvent } from "./buildTimeline";

const timeline: TimelineEvent[] = [
  { kind: "user_msg", text: "how many rows?" },
  { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT COUNT(*) FROM t;" } },
  { kind: "tool_response", name: "execute_sql", response: "count\n-----\n42" },
  { kind: "tool_call", name: "submit_sql", args: { sql: "SELECT COUNT(*) FROM t;" } },
];

describe("findExecutedResult", () => {
  it("returns the executed result for a previously-run identical SQL", () => {
    expect(findExecutedResult(timeline, "SELECT COUNT(*) FROM t;", 3)).toBe("count\n-----\n42");
  });

  it("matches ignoring surrounding whitespace", () => {
    expect(findExecutedResult(timeline, "  SELECT COUNT(*) FROM t; \n", 3)).toBe("count\n-----\n42");
  });

  it("returns null when the submitted SQL was never executed", () => {
    expect(findExecutedResult(timeline, "SELECT 1;", 3)).toBeNull();
  });
});
