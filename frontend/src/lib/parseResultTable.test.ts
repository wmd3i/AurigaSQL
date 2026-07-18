import { describe, expect, it } from "vitest";
import { formatCell, parseResultTable } from "./parseResultTable";

const TABULAR = `userel | uer
------------
737 | 1.47857142857142860000
107 | 1.01666666666666666667
817 | 0.97435897435897435897`;

describe("parseResultTable", () => {
  it("parses header, separator and pipe-delimited rows", () => {
    const t = parseResultTable(TABULAR);
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(["userel", "uer"]);
    expect(t!.rows).toHaveLength(3);
    expect(t!.rows[0]).toEqual(["737", "1.47857142857142860000"]);
    expect(t!.truncated).toBe(false);
  });

  it("parses single-column ascii tables", () => {
    const t = parseResultTable(`count\n-----\n0`);
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(["count"]);
    expect(t!.rows).toEqual([["0"]]);
    expect(t!.truncated).toBe(false);
  });

  it("flags word-budget truncation ('...' tail) and drops the marker row", () => {
    const t = parseResultTable(`a | b\n-----\n1 | 2\n...`);
    expect(t!.rows).toHaveLength(1);
    expect(t!.truncated).toBe(true);
  });

  it("parses pipe-delimited tables even when the separator row is omitted", () => {
    const t = parseResultTable(`a | b | c\n1 | 2 | 3`);
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(["a", "b", "c"]);
    expect(t!.rows).toEqual([["1", "2", "3"]]);
  });

  it("parses ascii separator rows that also contain pipes", () => {
    const t = parseResultTable(`a | b\n-----|-----\n1 | 2`);
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(["a", "b"]);
    expect(t!.rows).toEqual([["1", "2"]]);
  });

  it("skips explanatory comment text before embedded sample rows", () => {
    const t = parseResultTable(`/*
5 example random rows:

SELECT * FROM \`frpm\` LIMIT 5;

CDSCode | Academic Year | County Code
45699976050322 | 2014-2015 | 45
10621170113563 | 2014-2015 | 10
*/`);
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(["CDSCode", "Academic Year", "County Code"]);
    expect(t!.rows).toEqual([
      ["45699976050322", "2014-2015", "45"],
      ["10621170113563", "2014-2015", "10"],
    ]);
  });

  it("parses flattened one-line tables when a single row is preserved", () => {
    const t = parseResultTable(
      "a | b | c ----------------------------- 1 | two words | 3",
    );
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(["a", "b", "c"]);
    expect(t!.rows).toEqual([["1", "two words", "3"]]);
  });

  it("marks flattened partial tails as truncated and keeps the complete row", () => {
    const t = parseResultTable(
      "a | b | c ----------------------------- 1 | two words | 3...",
    );
    expect(t).not.toBeNull();
    expect(t!.rows).toEqual([["1", "two words", "3"]]);
    expect(t!.truncated).toBe(true);
  });

  it("returns null for plain messages (no separator line)", () => {
    expect(parseResultTable("Query executed successfully.")).toBeNull();
    expect(parseResultTable("Query executed, empty result set.")).toBeNull();
    expect(parseResultTable("")).toBeNull();
  });
});

describe("formatCell", () => {
  it("rounds long decimals to 4 places for display", () => {
    expect(formatCell("1.47857142857142860000")).toBe("1.4786");
    expect(formatCell("-0.59769230769230769231")).toBe("-0.5977");
  });

  it("leaves short numbers and non-numbers untouched", () => {
    expect(formatCell("737")).toBe("737");
    expect(formatCell("3.14")).toBe("3.14");
    expect(formatCell("Observatory-East")).toBe("Observatory-East");
  });
});
