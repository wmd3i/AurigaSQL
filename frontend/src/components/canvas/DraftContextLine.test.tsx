import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftContextLine } from "./DraftContextLine";

describe("DraftContextLine", () => {
  it("says where the follow-up starts and how many cards it carries", () => {
    const html = renderToStaticMarkup(<DraftContextLine anchorLabel="Final Result" lines={["Q · You asked", "Q · Run SQL", "Q · Final Result"]} />);
    expect(html).toContain("From Final Result · includes 3 earlier cards");
    expect(html).toContain("Q · Run SQL");
  });

  it("uses the singular for one card", () => {
    const html = renderToStaticMarkup(<DraftContextLine anchorLabel="You asked" lines={["Q · You asked"]} />);
    expect(html).toContain("includes 1 earlier card<");
  });
});
