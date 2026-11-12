import { describe, expect, it } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };
import * as ai from "../src/ai.ts";
import * as root from "../src/index.ts";
import { builtins } from "../src/providers/index.ts";
import { databasesTools } from "../src/tools.ts";

describe("@agntn/databases", () => {
  it("exports the version from package.json", () => {
    expect(root.version).toBe(pkg.version);
  });

  it("keeps the public API to these names", () => {
    expect(Object.keys(root).sort()).toEqual([
      "DEFAULT_ROWS",
      "DEFAULT_SAMPLE_ROWS",
      "DatabasesError",
      "MAX_PARAMS",
      "MAX_ROWS",
      "MAX_SQL_LENGTH",
      "Provider",
      "STATEMENT_TIMEOUT_MS",
      "UnknownProviderError",
      "connectionVariable",
      "create",
      "listConnections",
      "listProviders",
      "open",
      "parseReference",
      "providers",
      "redactUrl",
      "register",
      "version",
    ]);
  });

  it("loads every built-in under its own key", async () => {
    for (const entry of builtins) {
      const providerClass = (await entry.load()) as unknown as { key: string };
      expect(providerClass.key).toBe(entry.key);
    }
    expect(root.providers()).toEqual(["sqlite", "postgres", "d1"]);
  });

  it("keys the AI SDK tools by the shared names", () => {
    expect(Object.keys(ai.databasesAiTools)).toEqual(databasesTools.map((tool) => tool.name));
  });

  it("lets a provider from outside take a key", async () => {
    class Memory extends root.Provider {
      static readonly key = "memory";
      get key(): string {
        return Memory.key;
      }
      tables = async () => [];
      table = async () => {
        throw new Error("none");
      };
      query = async () => ({ columns: [{ name: "x" }], rows: [[1]], more: false, cut: false });
      explain = async () => ({ lines: [] });
      execute = async () => ({ changes: 0 });
      protected quoteTable(name: string): string {
        return name;
      }
    }
    root.register(
      { key: "memory", title: "Memory", reference: "-", readOnly: "nothing writes" },
      Memory,
    );

    const provider = await root.create({ provider: "memory", target: "x", label: "memory" });
    expect((await provider.sample("t")).rows).toEqual([[1]]);
    await expect(root.create({ provider: "mysql", target: "x", label: "x" })).rejects.toThrow(
      'Unknown provider "mysql"',
    );
  });
});
