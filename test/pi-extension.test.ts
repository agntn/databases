import { fileURLToPath } from "node:url";

import { wireSchema } from "@agntn/tools";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { databasesTools, queryTool } from "../src/tools.ts";
import { loadPiExtension } from "./fixtures/pi-host.ts";
import { readDirect, sqliteFixture } from "./helpers.ts";

const extensionPath = fileURLToPath(new URL("../extensions/pi/databases.ts", import.meta.url));
const fixture = sqliteFixture();

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  fixture.dispose();
});

describe("pi databases extension", () => {
  it("registers every tool", async () => {
    const host = await loadPiExtension(extensionPath);

    expect([...host.tools.keys()]).toEqual(databasesTools.map((tool) => tool.name));
  });

  it("hands Pi the shared schema and refuses what it rejects", async () => {
    const host = await loadPiExtension(extensionPath);
    const tool = host.tool("databases_query");
    const outcome = async (args: Record<string, unknown>): Promise<string> =>
      Promise.resolve(tool.execute("call-1", args, undefined, undefined, host.context)).then(
        () => "ran",
        (error: unknown) =>
          error instanceof Error && error.message.startsWith("Invalid arguments")
            ? "invalid"
            : "failed",
      );

    expect(tool.parameters).toEqual(wireSchema(queryTool));
    expect(await outcome({ database: fixture.path, sql: "SELECT 1" })).toBe("ran");
    expect(await outcome({ database: fixture.path })).toBe("invalid");
    expect(await outcome({ database: fixture.path, sql: "SELECT 1", limit: "5" })).toBe("invalid");
    expect(await outcome({ database: fixture.path, sql: "DELETE FROM items" })).toBe("failed");
  });

  it("executes through the shared executor and returns structured details", async () => {
    const host = await loadPiExtension(extensionPath);

    const result = await host
      .tool("databases_query")
      .execute(
        "call-1",
        { database: fixture.path, sql: "SELECT name FROM owners" },
        undefined,
        undefined,
        host.context,
      );

    expect(result.content[0]?.type).toBe("text");
    expect(result.details).toMatchObject({ provider: "sqlite", rows: [["Ada"], ["Linus"]] });
  });

  it.each([true, false])("writes without approval with hasUI=%s", async (hasUI) => {
    const writable = sqliteFixture();
    try {
      const host = await loadPiExtension(extensionPath);
      const asked: string[] = [];
      /* The runner's context reads its state lazily, so this one only overrides the two fields. */
      const context = Object.create(host.context, {
        hasUI: { value: hasUI },
        ui: {
          value: {
            confirm: async (title: string, message: string) => {
              asked.push(`${title}\n${message}`);
              return false;
            },
          },
        },
      }) as typeof host.context;

      const result = await host
        .tool("databases_execute")
        .execute(
          "call-1",
          { database: writable.path, sql: "DELETE FROM items" },
          undefined,
          undefined,
          context,
        );
      expect(asked).toEqual([]);
      expect(result.content).toEqual([
        { type: "text", text: `${writable.path} (sqlite): 3 rows changed` },
      ]);
      expect(result.details).toMatchObject({ provider: "sqlite", changes: 3 });
      expect(readDirect(writable.path, "SELECT count(*) AS n FROM items")).toEqual([{ n: 0 }]);
    } finally {
      writable.dispose();
    }
  });
});
