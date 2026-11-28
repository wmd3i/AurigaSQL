import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FollowUpPlus } from "./FollowUpPlus";

const noop = () => {};

describe("FollowUpPlus", () => {
  it("renders nothing for an unavailable side without branches", () => {
    expect(renderToStaticMarkup(<FollowUpPlus side="left" available={false} selected={false} onClick={noop} />)).toBe("");
  });

  it("hides the plus until the card is hovered", () => {
    const html = renderToStaticMarkup(<FollowUpPlus side="right" available selected={false} onClick={noop} />);
    expect(html).toContain('aria-label="Follow up on the right"');
    expect(html).toContain("opacity-0");
  });

  it("shows the plus while the card is selected", () => {
    const html = renderToStaticMarkup(<FollowUpPlus side="bottom" available selected onClick={noop} />);
    expect(html).toContain('aria-label="Follow up below"');
    expect(html).not.toContain("opacity-0");
  });

  it("toggles the side's follow-ups from the count and adds from a separate plus", () => {
    const html = renderToStaticMarkup(<FollowUpPlus side="right" count={2} available selected={false} onClick={noop} onToggle={noop} />);
    expect(html).toContain('aria-label="Hide 2 follow-ups on the right"');
    expect(html).toContain('aria-label="Follow up on the right"');
    expect(html).toContain(">2<");
  });

  it("offers to show the follow-ups again once collapsed", () => {
    const html = renderToStaticMarkup(<FollowUpPlus side="left" count={1} collapsed available selected={false} onClick={noop} onToggle={noop} />);
    expect(html).toContain('aria-label="Show 1 follow-up on the left"');
    expect(html).toContain('data-collapsed="true"');
  });

  it("shows a plain count badge when the side cannot take another follow-up", () => {
    const html = renderToStaticMarkup(<FollowUpPlus side="right" count={3} available={false} selected={false} onClick={noop} />);
    expect(html).not.toContain("<button");
    expect(html).toContain(">3<");
  });

  it("becomes visible when reached with the keyboard", () => {
    const plus = renderToStaticMarkup(<FollowUpPlus side="right" available selected={false} onClick={noop} />);
    expect(plus).toContain("group-focus-visible:opacity-100");
    const withCount = renderToStaticMarkup(<FollowUpPlus side="right" count={2} available selected={false} onClick={noop} onToggle={noop} />);
    expect(withCount).toContain("group-focus-visible:opacity-100");
  });
});
