import { describe, expect, it } from "vitest";
import { cardLabel, toolCardTitle, toolDisplayName } from "./cardKind";
import type { CardContent } from "./ThreadNodeCard";

describe("toolDisplayName", () => {
  it("maps known tool names to natural language", () => {
    expect(toolDisplayName("get_schema")).toBe("Inspect database schema");
  });

  it("humanizes unknown tools without exposing snake_case", () => {
    expect(toolDisplayName("get_user_profile")).toBe("Look up user profile");
    expect(toolDisplayName("search_order_history")).toBe("Search order history");
  });
});

describe("toolCardTitle", () => {
  it("uses a checking title for execute_sql cards", () => {
    expect(toolCardTitle("execute_sql", "Count the rows with missing scores")).toBe("Counting the rows with missing scores");
  });

  it("makes inferred summaries sound more natural", () => {
    expect(toolCardTitle("execute_sql", "Compare grouped counts")).toBe("Comparing grouped counts");
    expect(toolCardTitle("execute_sql", "Count rows with missing values")).toBe("Checking for missing values");
  });
});

describe("cardLabel", () => {
  it("uses natural-language names for tool cards", () => {
    const node: CardContent = {
      id: "tool-1",
      kind: "tool",
      title: "get_all_column_meanings",
      body: "",
      result: undefined,
    };

    expect(cardLabel(node)).toBe("Explain table columns");
  });

  it("uses the execute_sql summary in the visible title", () => {
    const node: CardContent = {
      id: "tool-2",
      kind: "tool",
      title: "execute_sql",
      body: "SELECT COUNT(*) FROM t",
      summary: "Count the rows with missing scores",
      result: "count\n---\n12",
    };

    expect(cardLabel(node)).toBe("Counting the rows with missing scores");
  });
});
