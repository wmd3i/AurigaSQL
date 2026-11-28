import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { ThreadNodeCard, type CardData } from "./ThreadNodeCard";

function render(data: CardData) {
  const props = { id: "t:error", data, selected: true, type: "card" } as unknown as Parameters<typeof ThreadNodeCard>[0];
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <ThreadNodeCard {...props} />
    </ReactFlowProvider>,
  );
}

describe("ThreadNodeCard follow-up controls", () => {
  it("offers follow-up pluses on an Error card", () => {
    const html = render({
      tn: { id: "error", kind: "error", body: "boom" },
      pulse: false,
      footer: null,
      followUpSides: { left: true, right: true, below: true },
      onFollowUp: () => {},
    });
    expect(html).toContain('aria-label="Follow up on the left"');
    expect(html).toContain('aria-label="Follow up below"');
  });
});
