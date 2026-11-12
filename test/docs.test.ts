import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/** The generator is plain JavaScript the site build also runs, so it has no types to import. */
const generator = (await import(new URL("../docs/scripts/samples.mjs", import.meta.url).href)) as {
  buildSamples: () => Promise<unknown>;
};

const committed = JSON.parse(
  readFileSync(new URL("../docs/app/data/samples.json", import.meta.url), "utf8"),
) as {
  engines: Array<{ key: string }>;
  queries: Array<{ id: string; error?: { code: string } }>;
  verdicts: Array<{ sql: string; sqlite: string; d1: string }>;
};

describe("the landing data", () => {
  /** A change to an executor, the guard or the parser has to regenerate it: `node docs/scripts/samples.mjs`. */
  it("is what the library returns today", async () => {
    expect(await generator.buildSamples()).toEqual(committed);
  });

  it("names every built-in engine", () => {
    expect(committed.engines.map((engine) => engine.key)).toEqual(["sqlite", "postgres", "d1"]);
  });

  it("shows two reads and two refusals in the hero", () => {
    expect(committed.queries.map((query) => query.error?.code ?? "read")).toEqual([
      "read",
      "read",
      "refused",
      "refused",
    ]);
  });

  it("agrees between a file and a D1 schema copy on every statement", () => {
    for (const verdict of committed.verdicts) expect(verdict.d1).toBe(verdict.sqlite);
  });
});
