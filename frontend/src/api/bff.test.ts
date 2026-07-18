import { afterEach, describe, expect, it, vi } from "vitest";

describe("bff api contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("parses freechat start responses without a legacy budget field", async () => {
    vi.stubGlobal("window", {
      aurigaDesktop: { backendBase: "http://bff.test" },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          task_id: "freechat_123",
          mode: "free-chat",
          user_query: "How many rows?",
          source: {
            id: "demo_sqlite",
            source_group: "bird",
            engine: "sqlite",
            display_name: "Demo SQLite",
            ready: true,
            source_type: "demo",
            database: "demo",
            db_path: "/tmp/demo.sqlite",
            schema_path: null,
            connection_id: null,
            description: "",
            reason: "",
          },
        }),
        { status: 200, statusText: "OK" },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { bff } = await import("./bff");

    const started = await bff.startFreechat("demo_sqlite", "How many rows?");

    expect(started.task_id).toBe("freechat_123");
    expect(started.database).toBe("Demo SQLite");
    expect(started).not.toHaveProperty("budget");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff.test/freechat/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          source_id: "demo_sqlite",
          query: "How many rows?",
        }),
      }),
    );
  });

  it("parses product-facing demo connection groups", async () => {
    vi.stubGlobal("window", {
      aurigaDesktop: { backendBase: "http://bff.test" },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      connections: [{
        source_group: "bird",
        label: "BIRD SQLite",
        engine: "sqlite",
        description: "Bundled demo data",
        connected: true,
        ready_count: 6,
        reason: "",
      }],
    }), { status: 200, statusText: "OK" })));

    const { bff } = await import("./bff");
    const response = await bff.demoConnections();

    expect(response.connections).toHaveLength(1);
    expect(response.connections[0].source_group).toBe("bird");
  });
});
