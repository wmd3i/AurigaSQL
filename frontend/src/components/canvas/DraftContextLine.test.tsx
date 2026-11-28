import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftContextLine } from "./DraftContextLine";

describe("DraftContextLine", () => {
  it("says where the follow-up starts and how many cards it carries, without a hover list", () => {
    const html = renderToStaticMarkup(<DraftContextLine anchorLabel="Final Result" count={3} />);
    expect(html).toContain("From Final Result · includes 3 earlier cards");
    expect(html).not.toContain("group-hover");
  });

  it("uses the singular for one card", () => {
    const html = renderToStaticMarkup(<DraftContextLine anchorLabel="You asked" count={1} />);
    expect(html).toContain("includes 1 earlier card<");
  });
});
