import { describe, expect, it } from "vitest";
import { parseConnectionUri } from "./connectionUri";

describe("parseConnectionUri", () => {
  it("parses postgresql connection URI with sslmode and credentials", () => {
    const result = parseConnectionUri(
      "postgresql://auriga:auriga_demo@127.0.0.1:5433/auriga_demo?sslmode=disable",
    );
    expect(result).toEqual({
      ok: true,
      value: {
        engine: "postgres",
        name: "auriga_demo",
        host: "127.0.0.1",
        port: "5433",
        database: "auriga_demo",
        username: "auriga",
        password: "auriga_demo",
        sslmode: "disable",
      },
    });
  });

  it("parses postgres:// alias with URL-encoded password", () => {
    const result = parseConnectionUri("postgres://admin:p%40ss%3A123@db.internal/analytics");
    expect(result).toEqual({
      ok: true,
      value: {
        engine: "postgres",
        name: "analytics",
        host: "db.internal",
        port: "5432",
        database: "analytics",
        username: "admin",
        password: "p@ss:123",
        sslmode: undefined,
      },
    });
  });

  it("parses mysql:// URI with default port and strips IPv6 brackets", () => {
    const result = parseConnectionUri("mysql://root:secret@[::1]/orders");
    expect(result).toEqual({
      ok: true,
      value: {
        engine: "mysql",
        name: "orders",
        host: "::1",
        port: "3306",
        database: "orders",
        username: "root",
        password: "secret",
      },
    });
  });

  it("parses duckdb:// and local .db paths preserving preferred local engine", () => {
    expect(parseConnectionUri("duckdb:///tmp/sales.duckdb")).toEqual({
      ok: true,
      value: {
        engine: "duckdb",
        path: "/tmp/sales.duckdb",
        name: "sales",
      },
    });
    expect(parseConnectionUri("/Users/han/data/demo.db", "duckdb")).toEqual({
      ok: true,
      value: {
        engine: "duckdb",
        path: "/Users/han/data/demo.db",
        name: "demo",
      },
    });
  });

  it("rejects hostless network URIs, invalid sslmode, unsupported query params, and relative sqlite URIs", () => {
    expect(parseConnectionUri("postgresql:///auriga_demo").ok).toBe(false);
    expect(parseConnectionUri("postgresql://user:pw@localhost/db?sslmode=bogus").ok).toBe(false);
    expect(parseConnectionUri("postgresql://user:pw@localhost/db?sslrootcert=/tmp/ca.pem").ok).toBe(false);
    expect(parseConnectionUri("mysql://user:pw@localhost/db?charset=utf8").ok).toBe(false);
    expect(parseConnectionUri("sqlite://db.sqlite").ok).toBe(false);
    expect(parseConnectionUri("sqlite:///tmp/db.sqlite?mode=ro").ok).toBe(false);
    expect(parseConnectionUri("mongodb://localhost:27017/app").ok).toBe(false);
  });
});
