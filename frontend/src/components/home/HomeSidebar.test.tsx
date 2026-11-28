import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reducer } from "../../state/reducer";
import { initialState, type ConversationStatus } from "../../state/types";
import { HomeSidebar } from "./HomeSidebar";
import { PendingChatsContext } from "../../state/pendingChatsContext";
import { CanvasRail } from "../canvas/CanvasRail";

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
};

describe("History loading indicators", () => {
  it("keeps background pending questions visible without a foreground preview", () => {
    const history = renderToStaticMarkup(
      <PendingChatsContext.Provider value={{
        chats: [
          { id: "first", title: "First question", createdAt: 1 },
          { id: "second", title: "Second question", database: "Credit data", createdAt: 2 },
        ],
        dispatch: () => {},
      }}>
        <HomeSidebar {...callbacks} conversations={[]} pendingChat={null} />
      </PendingChatsContext.Provider>,
    );
    expect(history).toContain("First question");
    expect(history).toContain("Second question");
    expect(history).toContain("Choosing a database…");
    expect(history.match(/title="Working"/g)).toHaveLength(2);
    expect(history).not.toContain("No conversations yet.");
  });

  it("shows the submitted question while its database is still being selected", () => {
    const history = renderToStaticMarkup(
      <HomeSidebar {...callbacks} conversations={[]} pendingChat={{ title: query }} />,
    );
    expect(history).toContain(query);
    expect(history).toContain("Choosing a database…");
    expect(history).toContain('title="Working"');
    expect(history.indexOf('title="Working"')).toBeLessThan(history.indexOf(query));
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

/* The chosen History icon set lives in localStorage; stub a window holding one value. */
function useStoredIconStyle(value: string | null) {
  vi.stubGlobal("window", {
    localStorage: { getItem: () => value, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

describe("History icons", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const conversations = [conversation("first", "done"), conversation("second", "done")];
  const retroPetsSvg = /<svg viewBox="2 2 36 36" aria-hidden="true"/g;

  it("marks each chat history entry with an icon from the default set", () => {
    const history = renderToStaticMarkup(<HomeSidebar {...callbacks} conversations={conversations} />);
    expect(history.match(retroPetsSvg)).toHaveLength(2);
  });

  it("uses the set chosen in Settings", () => {
    useStoredIconStyle("starSketch");
    const history = renderToStaticMarkup(<HomeSidebar {...callbacks} conversations={conversations} />);
    expect(history).not.toMatch(retroPetsSvg);
    expect(history.match(/<svg viewBox="0 0 40 40" aria-hidden="true"/g)).toHaveLength(2);
  });

  it("gives a conversation the same icon in chat and canvas", () => {
    const chat = renderToStaticMarkup(<HomeSidebar {...callbacks} conversations={conversations.slice(0, 1)} />);
    const canvas = renderToStaticMarkup(<CanvasRail conversations={conversations.slice(0, 1)} activeId={null} onSelectThread={() => {}} />);
    const icon = (html: string) => html.slice(html.indexOf('<svg viewBox="2 2 36 36"'), html.indexOf("</svg>", html.indexOf('<svg viewBox="2 2 36 36"')));
    // Ids from useId differ between renders; compare the drawing itself.
    const strip = (svg: string) => svg.replace(/ha-[^")]+/g, "ID").replace(/class="[^"]*"/, "");
    expect(icon(chat)).not.toBe("");
    expect(strip(icon(chat))).toBe(strip(icon(canvas)));
  });

  it("shows a neutral disc for a chat that is still starting", () => {
    const history = renderToStaticMarkup(<HomeSidebar {...callbacks} conversations={[]} pendingChat={{ title: query }} />);
    expect(history).toContain("rounded-full bg-hover");
    expect(history).not.toMatch(retroPetsSvg);
  });

  it("shows no icons when turned off, and the canvas keeps its status dot", () => {
    useStoredIconStyle("off");
    const chat = renderToStaticMarkup(
      <HomeSidebar {...callbacks} conversations={conversations} pendingChat={{ title: query }} />,
    );
    const canvas = renderToStaticMarkup(<CanvasRail conversations={conversations} activeId={null} onSelectThread={() => {}} />);
    expect(chat).not.toContain("<svg viewBox=");
    expect(chat).not.toContain("rounded-full bg-hover");
    expect(canvas).not.toContain("<svg viewBox=");
    expect(canvas.match(/h-2\.5 w-2\.5 shrink-0 rounded-full/g)).toHaveLength(2);
  });
});
