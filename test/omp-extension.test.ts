import { ToolInputError, wireSchema } from "@agntn/tools";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";

/** Compiled OMP injects no TUI barrel, so loading it has to fail the test. */
vi.mock("@oh-my-pi/pi-coding-agent/tui", () => {
  throw new Error("The OMP host does not inject the TUI barrel");
});

import databasesExtension from "../extensions/omp/databases.ts";
import { databasesTools, queryTool } from "../src/tools.ts";
import {
  ompTestTheme as theme,
  ompToolContext,
  registerOmpExtension,
} from "./fixtures/omp-host.ts";
import { sqliteFixture } from "./helpers.ts";

const CONTROL_BYTES = /\p{Cc}/u;
const fixture = sqliteFixture();

afterAll(() => {
  fixture.dispose();
});

async function tool(name: string): Promise<ToolDefinition> {
  return (await registerOmpExtension(databasesExtension)).tool(name);
}

function renderedText(component: unknown): string {
  return (component as { text: string }).text;
}

describe("omp databases extension", () => {
  it("registers every tool with the approval its effect asks for", async () => {
    const host = await registerOmpExtension(databasesExtension);

    expect([...host.tools.keys()]).toEqual(databasesTools.map((definition) => definition.name));
    expect(host.labels).toEqual(["Databases"]);
    expect(host.tool("databases_query").approval).toBe("read");
    expect(host.tool("databases_execute").approval).not.toBe("read");
  });

  it("hands OMP the shared schema and refuses what it rejects", async () => {
    const query = await tool("databases_query");
    const outcome = async (args: Record<string, unknown>): Promise<string> =>
      Promise.resolve(query.execute("call-1", args, undefined, undefined, ompToolContext)).then(
        () => "ran",
        (error: unknown) => (error instanceof ToolInputError ? "invalid" : "failed"),
      );

    expect(query.parameters).toEqual(wireSchema(queryTool));
    expect(await outcome({ database: fixture.path, sql: "SELECT 1" })).toBe("ran");
    expect(await outcome({ database: fixture.path, sql: "SELECT 1", limit: 0 })).toBe("invalid");
    expect(await outcome({ database: fixture.path })).toBe("invalid");
  });

  it("draws the database and the start of the statement", async () => {
    const query = await tool("databases_query");

    const text = renderedText(
      query.renderCall?.(
        { database: "shop", sql: `SELECT\n  *\nFROM ${"t".repeat(100)}` },
        { expanded: false, isPartial: false },
        theme,
      ),
    );

    expect(text).toBe(
      `success:status.done accent(Query Database): muted(shop SELECT * FROM ${"t".repeat(46)}…)`,
    );
  });

  it("sanitizes model arguments in renderCall", async () => {
    const query = await tool("databases_query");

    const text = renderedText(
      query.renderCall?.(
        { database: "\u001B]0;evil\u0007shop\u202E", sql: "SELECT 1" },
        { expanded: false, isPartial: false },
        theme,
      ),
    );

    expect(text).not.toMatch(CONTROL_BYTES);
    expect(text).not.toContain("\u202E");
  });

  it("counts rows in renderResult", async () => {
    const query = await tool("databases_query");
    const result = {
      content: [{ type: "text" as const, text: "ok" }],
      details: { rows: [[1], [2]], more: true },
    };

    expect(
      renderedText(query.renderResult?.(result, { expanded: false, isPartial: false }, theme)),
    ).toBe(
      "success:status.done accent(Query Database) accent([read]) dim(2 rows | more)\ntoolOutput(ok)",
    );
  });
});
