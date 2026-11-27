import { mkdirSync, mkdtempSync, readFile, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DatabasesError } from "../src/core/errors.ts";
import { open } from "../src/core/registry.ts";
import * as sqlite from "../src/sqlite.ts";
import { readDirect } from "./helpers.ts";

const directory = mkdtempSync(join(tmpdir(), "databases-read-"));
const path = join(directory, "sessions.db");
const transcript = `${"🎸".repeat(400)}tail`;
const blob = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);

{
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE part (id INTEGER PRIMARY KEY, data TEXT, raw BLOB, big INTEGER, real)");
  const insert = db.prepare("INSERT INTO part (data, raw, big, real) VALUES (?, ?, ?, ?)");
  insert.run(transcript, blob, 9_007_199_254_740_993n, -0);
  insert.run("a\u0000b", null, 2, 0.5);
  db.exec("INSERT INTO part (data, real) VALUES ('inf', 1e999), ('-inf', -1e999)");
  db.exec(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2996) INSERT INTO part (data) SELECT 'row ' || i FROM n",
  );
  db.close();
}

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
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

/** Runs each case in this process and through the child a host without node:sqlite uses. */
const hosts = [
  { host: "in process", child: false },
  { host: "in a child process", child: true },
];

describe.each(hosts)("read, $host", ({ child }) => {
  /** Hides node:sqlite from the check, as Bun-less builds of a host would. */
  function host(): void {
    if (child) vi.spyOn(process, "getBuiltinModule").mockReturnValue(undefined);
  }

  it("names a statement SQLite fails as it runs", async () => {
    host();
    const error = await sqlite
      .read(path, { sql: "SELECT abs(-9223372036854775807 - 1)" })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DatabasesError);
    expect(error).toMatchObject({ code: "query", message: "integer overflow" });
  });

  it("keeps every value whole", async () => {
    host();
    const { columns, rows, more } = await sqlite.read(path, {
      sql: "SELECT data, raw, big, real FROM part WHERE id <= 4 ORDER BY id",
    });
    expect(columns.map((column) => column.name)).toEqual(["data", "raw", "big", "real"]);
    expect(more).toBe(false);
    expect(rows[0]?.[0]).toBe(transcript);
    expect(rows[0]?.[1]).toEqual(blob);
    expect(rows[0]?.[2]).toBe(9_007_199_254_740_993n);
    expect(Object.is(rows[0]?.[3], -0)).toBe(true);
    expect(rows[1]).toEqual(["a\u0000b", null, 2, 0.5]);
    expect(rows[2]?.[3]).toBe(Number.POSITIVE_INFINITY);
    expect(rows[3]?.[3]).toBe(Number.NEGATIVE_INFINITY);
  });

  it("binds -0 as -0", async () => {
    host();
    const { rows } = await sqlite.read(path, { sql: "SELECT ?", params: [-0] });
    expect(Object.is(rows[0]?.[0], -0)).toBe(true);
  });

  it("reads every row without a limit, and stops at one", async () => {
    host();
    const all = await sqlite.read(path, { sql: "SELECT id FROM part" });
    expect(all.rows).toHaveLength(3000);
    expect(all.more).toBe(false);

    const page = await sqlite.read(path, {
      sql: "SELECT id FROM part WHERE id > ? ORDER BY id",
      params: [1000],
      limit: 1500,
    });
    expect(page.rows).toHaveLength(1500);
    expect(page.rows[0]).toEqual([1001]);
    expect(page.more).toBe(true);
  });

  it("refuses a write and leaves the file alone", async () => {
    host();
    expect(await failure(sqlite.read(path, { sql: "DELETE FROM part" }))).toBe("refused");
    expect(await failure(sqlite.read(path, { sql: "SELECT 1; DELETE FROM part" }))).toBe("refused");
    expect(readDirect(path, "SELECT count(*) AS n FROM part")).toEqual([{ n: 3000 }]);
  });

  it("names a path SQLite can't open as a query error", async () => {
    host();
    const folder = join(directory, "folder.db");
    mkdirSync(folder, { recursive: true });
    expect(await failure(sqlite.read(folder, { sql: "SELECT 1" }))).toBe("query");
  });

  it("sends every row of an answer larger than one string can hold", async () => {
    host();
    const big = join(directory, "big.db");
    const db = new DatabaseSync(big);
    db.exec("CREATE TABLE t (a TEXT)");
    const insert = db.prepare("INSERT INTO t VALUES (?)");
    const mib = "x".repeat(1 << 20);
    for (let row = 0; row < 600; row += 1) insert.run(mib);
    db.close();
    const { rows } = await sqlite.read(big, { sql: "SELECT a FROM t" });
    expect(rows).toHaveLength(600);
    expect(rows.every((row) => row[0] === mib)).toBe(true);
    rmSync(big);
  });

  it("refuses a file that isn't there instead of creating it", async () => {
    host();
    const missing = join(directory, "none.db");
    expect(await failure(sqlite.read(missing, { sql: "SELECT 1" }))).toBe("config");
    expect(await failure(open(missing).then((db) => db.tables()))).toBe("config");
  });

  it("stops at the caller's deadline", async () => {
    host();
    const started = performance.now();
    const outcome = await failure(
      sqlite.read(path, {
        sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c",
        timeoutMs: 300,
      }),
    );
    expect(outcome).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("stops when the caller aborts", async () => {
    host();
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = sqlite.read(path, {
      sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 200);
    await expect(pending).rejects.toBe(reason);
  });

  it("never starts a read aborted while its module loads", async () => {
    host();
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = sqlite.read(path, {
      sql: "SELECT abs(-9223372036854775807 - 1)",
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("lets a deadline that came due in the last step win, from an I/O callback", async () => {
    host();
    const outcome = await new Promise<unknown>((resolve) => {
      readFile(path, () => {
        const signal = AbortSignal.timeout(30);
        sqlite
          .read(path, {
            sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3000000) SELECT n FROM c ORDER BY n DESC LIMIT 1",
            signal,
          })
          .then(
            () => resolve("resolved"),
            (error: unknown) => resolve(error instanceof Error ? error.name : error),
          );
      });
    });
    expect(outcome).toBe("TimeoutError");
  });

  it("rejects an abort that lands while a short answer is still sorting", async () => {
    host();
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = sqlite.read(path, {
      sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3000000) SELECT n FROM c ORDER BY n DESC LIMIT 1",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 50);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("read", () => {
  it("exports read alone", () => {
    expect(Object.keys(sqlite)).toEqual(["read"]);
  });

  it("takes only SQLite", async () => {
    expect(
      await failure(sqlite.read("postgres://reader@localhost/shop", { sql: "SELECT 1" })),
    ).toBe("config");
  });

  it("refuses a limit or deadline it can't keep, before opening anything", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(await failure(sqlite.read(path, { sql: "SELECT 1", limit }))).toBe("query");
    }
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(await failure(sqlite.read(path, { sql: "SELECT 1", timeoutMs }))).toBe("query");
    }
  });

  it("leaves the agent tools' budgets alone", async () => {
    const db = await open(path);
    const { rows, cut } = await db.query("SELECT data FROM part WHERE id = 1");
    expect(cut).toBe(true);
    expect(rows[0]?.[0]).toMatch(/… \[\+\d+ chars\]$/u);
  });
});
