import { describe, expect, it } from "vitest";
import { splitQuestions } from "./splitQuestions";

describe("splitQuestions", () => {
  it("keeps a single question (with a preamble + options list) as one", () => {
    const q =
      "I don't see TOLS. Relevant columns are: 1. sigclasstype 2. signalclass 3. sigpattern. " +
      "Could you clarify which column TOLS refers to?";
    expect(splitQuestions(q)).toEqual([q]);
  });

  it("fans out genuine multiple questions", () => {
    expect(splitQuestions("Which time range? Which metric? Group by what?")).toEqual([
      "Which time range?",
      "Which metric?",
      "Group by what?",
    ]);
  });

  it("treats a single question followed by a non-question sentence as one", () => {
    expect(splitQuestions("What is X? Thanks.")).toEqual(["What is X? Thanks."]);
  });

  it("returns an empty list for blank input", () => {
    expect(splitQuestions("   ")).toEqual([]);
  });
});
