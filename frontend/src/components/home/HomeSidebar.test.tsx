import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { reducer } from "../../state/reducer";
import { initialState, type ConversationStatus } from "../../state/types";
import { HomeSidebar } from "./HomeSidebar";

const query = "Compare average credit utilization across customer segments.";

function conversation(id: string, status: ConversationStatus) {
  const state = reducer(initialState, {
    type: "CONVERSATION_STARTED",
    id,
    database: "Credit data",
    databases: ["Credit data"],
    title: id,
    createdAt: 1,
    mode: "agent",
  });
  return { ...state.conversations[0], status };
}

const callbacks = {
  onNewFlow: () => {},
  onOpen: () => {},
  onOpenWorkspaceSetup: () => {},
};

describe("History loading indicators", () => {
  it("shows the submitted question while its database is still being selected", () => {
    const history = renderToStaticMarkup(
      <HomeSidebar {...callbacks} conversations={[]} pendingChat={{ title: query }} />,
    );
    expect(history).toContain(query);
    expect(history).toContain("Choosing a database…");
    expect(history).toContain('title="Working"');
    expect(history).not.toContain("No conversations yet.");
  });

  it("shows loading for starting and running chats even while another chat is selected", () => {
    const history = renderToStaticMarkup(
      <HomeSidebar
        {...callbacks}
        conversations={[conversation("starting", "starting"), conversation("running", "active"), conversation("selected", "done")]}
        activeConversationId="selected"
      />,
    );
    expect(history.match(/title="Working"/g)).toHaveLength(2);
  });

  it("clears the loading indicator for chats that have settled or need input", () => {
    const history = renderToStaticMarkup(
      <HomeSidebar
        {...callbacks}
        conversations={[
          conversation("completed", "done"),
          conversation("clarification", "waiting_user"),
          conversation("stopped", "stopped"),
          conversation("failed", "error"),
        ]}
      />,
    );
    expect(history).not.toContain('title="Working"');
  });
});
