import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DataSource, TaskItem } from "../../api/bff";
import { filterSampleTasks, QuestionCards } from "./QuestionCards";

function makeSource(id: string, displayName: string, engine: DataSource["engine"] = "sqlite"): DataSource {
  return {
    id,
    source_type: "demo",
    engine,
    display_name: displayName,
    source_group: "bird-interact",
    ready: true,
    database: displayName.toLowerCase(),
    db_path: null,
    schema_path: null,
    connection_id: null,
    description: "",
    reason: "",
  };
}

function makeTask(id: string, sourceId: string, database: string, extra?: Partial<TaskItem>): TaskItem {
  return {
    instance_id: id,
    source_id: sourceId,
    database,
    amb_user_query: `Question for ${database} (${id})`,
    num_critical_ambiguity: 0,
    num_knowledge_ambiguity: 0,
    has_follow_up: false,
    ...extra,
  };
}

describe("filterSampleTasks", () => {
  const credit = makeSource("src-credit", "Credit");
  const museum = makeSource("src-museum", "Museum");
  const custom = makeSource("src-pg", "Demo Postgres", "postgres");
  const tasks = [
    makeTask("t1", "src-credit", "Credit"),
    makeTask("t2", "src-museum", "Museum"),
  ];

  it("returns all tasks when Auto is active", () => {
    expect(filterSampleTasks(tasks, null)).toEqual({
      tasks,
      filteredBySourceName: null,
    });
  });

  it("filters tasks by selected source when matching sample tasks exist", () => {
    expect(filterSampleTasks(tasks, credit)).toEqual({
      tasks: [tasks[0]],
      filteredBySourceName: "Credit",
    });
  });

  it("falls back to all tasks when a selected custom source has no sample tasks", () => {
    expect(filterSampleTasks(tasks, custom)).toEqual({
      tasks,
      filteredBySourceName: null,
    });
  });

  it("keeps multi-database rendering when filtered source matches", () => {
    const html = renderToStaticMarkup(
      <QuestionCards
        tasks={[
          makeTask("t1", "src-credit", "Credit", { has_follow_up: true }),
          makeTask("t2", "src-museum", "Museum", { num_critical_ambiguity: 1 }),
          makeTask("t3", "src-credit", "Credit"),
          makeTask("t4", "src-museum", "Museum"),
        ]}
        sources={[credit, museum]}
        filteredBySourceName="Credit"
        onPick={() => {}}
      />,
    );
    expect(html).toContain("Sample questions");
    expect(html).toContain("Credit");
    expect(html).toContain("Multi-turn");
    expect(html).toContain("Clarify");
    expect(html).toContain("1 / 2");
    expect(html).toContain('type="button"');
  });
});
