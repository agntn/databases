import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { DatabasesError } from "../src/core/errors.ts";
import { runChild } from "../src/core/sqlite-protocol.ts";
import type { Provider } from "../src/core/provider.ts";
import { open } from "../src/core/registry.ts";
import { HOSTILE_LABEL, readDirect, sqliteFixture } from "./helpers.ts";

const fixture = sqliteFixture();
let db: Provider;

beforeAll(async () => {
  db = await open(fixture.path);
});

afterAll(() => {
  fixture.dispose();
});

/** The code a call rejects with. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof DatabasesError ? error.code : String(error);
  }
}

describe("the sqlite provider", () => {
  it("lists tables and views", async () => {
    expect(await db.tables()).toEqual([
      { name: "items", kind: "table" },
      { name: "owned", kind: "view" },
      { name: "owners", kind: "table" },
    ]);
  });

  it("describes a table with its keys", async () => {
    const table = await db.table("ITEMS");
    expect(table).toMatchObject({ name: "items", kind: "table" });
    expect(table.columns.map((column) => column.name)).toEqual([
      "id",
      "owner_id",
      "label",
      "data",
      "big",
      "created",
    ]);
    expect(table.columns[0]).toEqual({
      name: "id",
      type: "INTEGER",
      nullable: true,
      primaryKey: 1,
    });
    expect(table.columns[5]).toMatchObject({ default: "'2026-01-01'" });
    expect(table.indexes).toEqual([{ name: "items_label", unique: true, columns: ["label"] }]);
    expect(table.foreignKeys).toEqual([
      { table: "owners", columns: ["owner_id"], references: ["id"] },
    ]);
    expect(await failure(db.table("missing"))).toBe("query");
  });

  it("reads rows with types, bigints kept exact and blobs as hex", async () => {
    const result = await db.query("SELECT id, label, data, big FROM items ORDER BY id");
    expect(result.columns).toEqual([
      { name: "id", type: "integer" },
      { name: "label", type: "text" },
      { name: "data", type: "blob" },
      { name: "big", type: "integer" },
    ]);
    expect(result.rows[0]).toEqual([1, "a", { $blob: "00ff", bytes: 2 }, "9007199254740993"]);
    expect(result.rows[2]?.[1]).toBe(HOSTILE_LABEL);
    expect(result.rows[2]?.[2]).toEqual({ $blob: "00".repeat(32), bytes: 100, cut: true });
    expect(result).toMatchObject({ more: false, cut: true });
  });

  it("stops at the limit and says more rows exist", async () => {
    const result = await db.query("SELECT id FROM items ORDER BY id", { limit: 2 });
    expect(result.rows).toEqual([[1], [2]]);
    expect(result.more).toBe(true);
    expect((await db.query("SELECT id FROM items", { limit: 3 })).more).toBe(false);
  });

  it("binds parameters, booleans as 1 and 0", async () => {
    const result = await db.query("SELECT label FROM items WHERE owner_id = ? AND (? OR 0)", {
      params: [1, true],
    });
    expect(result.rows).toEqual([["a"], ["b"]]);
    expect((await db.query("SELECT ? IS NULL", { params: [null] })).rows).toEqual([[1]]);
  });

  it.each([
    "DELETE FROM items",
    "WITH x AS (SELECT 1) UPDATE items SET label = 'z'",
    "SELECT 1; DELETE FROM items",
    "ATTACH '/tmp/x.db' AS x",
    "PRAGMA user_version = 9",
  ])("refuses %j and leaves the file as it was", async (sql) => {
    expect(await failure(db.query(sql))).toBe("refused");
    expect(readDirect(fixture.path, "SELECT count(*) AS n FROM items")).toEqual([{ n: 3 }]);
  });

  it("checks the limit and the parameters before anything runs", async () => {
    expect(await failure(db.query("SELECT 1", { limit: 0 }))).toBe("query");
    expect(await failure(db.query("SELECT 1", { limit: 1.5 }))).toBe("query");
    expect(await failure(db.query("SELECT ?", { params: [{ a: 1 } as unknown as string] }))).toBe(
      "query",
    );
    expect(await failure(db.query("   "))).toBe("query");
  });

  it("explains a query as a tree", async () => {
    const plan = await db.explain("SELECT * FROM items WHERE label = ?", { params: ["a"] });
    expect(plan.lines.join("\n")).toMatch(/SEARCH items USING (COVERING )?INDEX items_label/u);
    expect(await failure(db.explain("DELETE FROM items"))).toBe("refused");
  });

  it("samples a table by name, quoting it", async () => {
    const sample = await db.sample("owned", { limit: 1 });
    expect(sample.columns.map((column) => column.name)).toEqual(["id", "name"]);
    expect(sample).toMatchObject({ rows: [[1, "Ada"]], more: true });
    expect(await failure(db.sample('items"; DROP TABLE items; --'))).toBe("query");
  });

  it("writes through execute only, one statement at a time", async () => {
    const writable = sqliteFixture();
    try {
      const target = await open(`sqlite:${writable.path}`);
      expect(
        await target.execute("INSERT INTO owners (name) VALUES (?)", { params: ["Grace"] }),
      ).toEqual({
        changes: 1,
        lastInsertId: "3",
      });
      expect(await failure(target.execute("DELETE FROM owners; DROP TABLE items"))).toBe("refused");
      expect(readDirect(writable.path, "SELECT count(*) AS n FROM owners")).toEqual([{ n: 3 }]);
    } finally {
      writable.dispose();
    }
  });

  it("refuses a file that isn't there instead of creating it", async () => {
    const missing = await open("/nonexistent/dir/none.db");
    expect(await failure(missing.query("SELECT 1"))).toBe("config");
    expect(await failure(missing.execute("CREATE TABLE t (a)"))).toBe("config");
  });

  it("kills a runaway statement at the deadline", async () => {
    const started = performance.now();
    const outcome = await failure(
      runChild(
        {
          kind: "file",
          path: fixture.path,
          write: false,
          steps: [
            {
              sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) FROM c",
              params: [],
              limit: 1,
            },
          ],
        },
        { timeoutMs: 500 },
      ),
    );
    expect(outcome).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const pending = db.query(
      "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) FROM c",
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("stop")), 200);
    await expect(pending).rejects.toThrow("stop");
  });
});
