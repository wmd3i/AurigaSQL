import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FollowUpOrigin } from "./FollowUpOrigin";

describe("FollowUpOrigin", () => {
  it("labels the card as a follow-up with a link back to its source card", () => {
    const html = renderToStaticMarkup(<FollowUpOrigin label="Final Result" onJump={() => {}} />);
    expect(html).toContain(">Follow-up<");
    expect(html).toContain("← Final Result");
    expect(html).toContain('aria-label="Go to Final Result, where this follow-up started"');
    expect(html).not.toMatch(/Fork|Parallel path|Continues from/);
  });
});
