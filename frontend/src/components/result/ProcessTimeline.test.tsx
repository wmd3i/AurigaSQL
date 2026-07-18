import { describe, expect, it } from "vitest";
import { buildCheckpoints } from "./ProcessTimeline";
import type { TimelineEvent } from "../../lib/buildTimeline";
import type { Conversation } from "../../state/types";

function conv(timeline: TimelineEvent[]): Conversation {
  return {
    id: "t1",
    database: "alien",
    databases: ["alien"],
    mode: "agent",
    canvasWorkId: null,
    parentThreadId: null,
    parentNodeId: null,
    title: "Classify signals by TOLS Category",
    summary: null,
    rawEvents: [],
    timeline,
    pendingQuestion: null,
    status: "done",
    turnInFlight: false,
    sseConnected: false,
    error: null,
    createdAt: 1,
  };
}

describe("buildCheckpoints", () => {
  it("keeps a result-page details checkpoint when only SQL output remains visible", () => {
    const checkpoints = buildCheckpoints(
      conv([
        { kind: "thinking", text: "Group signals by category" },
        { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT tols_category, COUNT(*) FROM signals GROUP BY 1" } },
        { kind: "tool_response", name: "execute_sql", response: "tols_category | count\nLow | 957" },
      ]),
    );

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      label: "Run SQL",
      toolName: "execute_sql",
    });
  });

  it("keeps a final SQL checkpoint for completed agent answers", () => {
    const checkpoints = buildCheckpoints(
      conv([
        { kind: "tool_call", name: "execute_sql", args: { sql: "SELECT 1" } },
        { kind: "tool_response", name: "execute_sql", response: "x\n1" },
        { kind: "tool_call", name: "submit_sql", args: { sql: "SELECT 1" } },
      ]),
    );

    expect(checkpoints.map((checkpoint) => checkpoint.toolName)).toContain("submit_sql");
  });
});
