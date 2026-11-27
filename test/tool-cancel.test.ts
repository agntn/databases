import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeTool } from "@agntn/tools";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readDirect, sqliteFixture } from "./helpers.ts";

/** Tools that change something, each with a call that would change the fixture. */
const writes: readonly (readonly [string, (database: string, directory: string) => object])[] = [
  ["databases_execute", (database) => ({ database, sql: "DELETE FROM items" })],
  ["databases_migrations_create", (_, directory) => ({ title: "add tags", directory })],
  ["databases_migrations_apply", (database, directory) => ({ database, directory })],
];

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("cancelled calls", () => {
  it("covers every tool that isn't a read", async () => {
    const { databasesTools } = await import("../src/tools.ts");
    const named = databasesTools.filter((tool) => tool.effect !== "read").map((tool) => tool.name);
    expect([...named].sort()).toEqual(writes.map(([name]) => name).sort());
  });

  it.each(writes)("never runs %s cancelled while the executors load", async (name, args) => {
    const fixture = sqliteFixture();
    const directory = mkdtempSync(join(tmpdir(), "databases-cancel-"));
    cleanups.push(fixture.dispose, () => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "0001_add_notes.sql"), "CREATE TABLE notes (id INTEGER);");
    vi.resetModules();
    const { databasesTools } = await import("../src/tools.ts");
    const tool = databasesTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} is missing`);

    const cancel = new AbortController();
    const call = invokeTool(tool, args(`sqlite:${fixture.path}`, directory), {
      signal: cancel.signal,
    });
    cancel.abort();

    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readDirect(fixture.path, "SELECT count(*) AS n FROM items")).toEqual([{ n: 3 }]);
    expect(readDirect(fixture.path, "SELECT name FROM sqlite_master WHERE name = 'notes'")).toEqual(
      [],
    );
    expect(readdirSync(directory)).toEqual(["0001_add_notes.sql"]);
  });
});
