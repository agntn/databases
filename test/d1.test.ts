import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DatabasesError } from "../src/core/errors.ts";
import { open } from "../src/core/registry.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const DATABASE = "11111111-2222-3333-4444-555555555555";

const SCHEMA = [
  "CREATE TABLE lessons (key TEXT PRIMARY KEY, rule TEXT NOT NULL)",
  "CREATE TABLE notes (id INTEGER PRIMARY KEY, lesson TEXT REFERENCES lessons (key), body TEXT)",
  "CREATE INDEX notes_lesson ON notes (lesson)",
];

interface Sent {
  readonly url: string;
  readonly sql?: string;
  readonly params?: unknown[];
  readonly authorization: string | null;
}

let sent: Sent[];

/** One JSON answer in the Cloudflare envelope. */
function answer(result: unknown, status = 200): Response {
  return Response.json(
    status === 200
      ? { success: true, errors: [], result }
      : { success: false, errors: [{ code: 7500, message: String(result) }], result: [] },
    { status },
  );
}

/** Raw rows the way D1 sends them. */
function raw(columns: string[], rows: unknown[][], meta: object = {}): Response {
  return answer([{ results: { columns, rows }, success: true, meta }]);
}

/** Canned answers by the start of the statement, the first match wins. */
const ROUTES: readonly (readonly [(sql: string) => boolean, () => Response])[] = [
  [
    (sql) => sql.startsWith("SELECT sql FROM sqlite_schema"),
    () =>
      raw(
        ["sql"],
        SCHEMA.map((statement) => [statement]),
      ),
  ],
  [
    (sql) => sql.startsWith("SELECT name, type, sql FROM sqlite_schema"),
    () =>
      raw(
        ["name", "type", "sql"],
        [
          ["_cf_KV", "table", "CREATE TABLE _cf_KV (key TEXT)"],
          ["lessons", "table", SCHEMA[0]],
          ["notes", "table", SCHEMA[1]],
        ],
      ),
  ],
  [
    (sql) => sql.startsWith("EXPLAIN QUERY PLAN"),
    () => raw(["id", "parent", "notused", "detail"], [[2, 0, 0, "SCAN lessons"]]),
  ],
  [(sql) => sql.includes("boom"), () => answer("D1_ERROR: boom: SQLITE_CONSTRAINT", 400)],
  [(sql) => sql.startsWith("UPDATE"), () => raw([], [], { changes: 2, last_row_id: 0 })],
];

function route(sql: string): Response {
  const found = ROUTES.find(([matches]) => matches(sql));
  return found
    ? found[1]()
    : raw(
        ["key", "rule", "key"],
        [
          ["a", "x\ny", "dup"],
          ["b", "z", "dup"],
          ["c", "w", "dup"],
        ],
      );
}

beforeEach(() => {
  sent = [];
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-test-token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { sql: string; params: unknown[] })
          : undefined;
      sent.push({
        url: input,
        authorization: new Headers(init?.headers).get("authorization"),
        ...(body ? { sql: body.sql, params: body.params } : {}),
      });
      return input.includes("/d1/database?name=")
        ? answer([{ uuid: DATABASE, name: "notes-app" }])
        : route(body?.sql ?? "");
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

describe("the d1 provider", () => {
  it("looks a database name up once and sends the token", async () => {
    const db = await open("d1:notes-app");
    await db.query("SELECT key, rule FROM lessons");
    await db.query("SELECT key FROM lessons");

    expect(sent.filter((request) => request.url.includes("?name=notes-app"))).toHaveLength(1);
    expect(sent.every((request) => request.authorization === "Bearer cf-test-token")).toBe(true);
    expect(sent.at(-1)?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/raw`,
    );
  });

  it("adds declared types from the schema copy and keeps duplicate names", async () => {
    const db = await open(`d1:${DATABASE}`);
    const result = await db.query("SELECT key, rule, key FROM lessons", { limit: 2 });

    expect(result.columns).toEqual([
      { name: "key", type: "text" },
      { name: "rule", type: "text" },
      { name: "key", type: "text" },
    ]);
    expect(result.rows).toEqual([
      ["a", "x\ny", "dup"],
      ["b", "z", "dup"],
    ]);
    expect(result.more).toBe(true);
  });

  it.each([
    "DELETE FROM lessons",
    "INSERT INTO notes (body) VALUES ('x')",
    "SELECT 1; DELETE FROM lessons",
    "DROP TABLE notes",
    "PRAGMA foreign_keys = off",
    "VACUUM",
  ])("refuses %j without sending it", async (sql) => {
    const db = await open(`d1:${DATABASE}`);

    expect(await failure(db.query(sql))).toBe("refused");
    expect(sent.filter((request) => request.sql === sql)).toEqual([]);
  });

  it("refuses a statement that doesn't fit the schema without sending it", async () => {
    const db = await open(`d1:${DATABASE}`);

    expect(await failure(db.query("SELECT * FROM _cf_KV"))).toBe("refused");
    expect(sent.some((request) => request.sql?.includes("_cf_KV") === true)).toBe(false);
  });

  it("hides D1's own tables from the listing and the description", async () => {
    const db = await open(`d1:${DATABASE}`);

    expect(await db.tables()).toEqual([
      { name: "lessons", kind: "table" },
      { name: "notes", kind: "table" },
    ]);
    expect(await failure(db.table("_cf_KV"))).toBe("query");
  });

  it("explains through EXPLAIN QUERY PLAN", async () => {
    const db = await open(`d1:${DATABASE}`);
    expect((await db.explain("SELECT * FROM lessons")).lines).toEqual(["SCAN lessons"]);
  });

  it("writes through execute and reports the changes", async () => {
    const db = await open(`d1:${DATABASE}`);

    expect(await db.execute("UPDATE lessons SET rule = ?", { params: ["r"] })).toEqual({
      changes: 2,
    });
    expect(sent.at(-1)).toMatchObject({ sql: "UPDATE lessons SET rule = ?", params: ["r"] });
    expect(await failure(db.execute("UPDATE lessons SET rule = 1; DROP TABLE notes"))).toBe(
      "refused",
    );
  });

  it("passes D1's own error on as a query error", async () => {
    const db = await open(`d1:${DATABASE}`);
    let caught: unknown;
    try {
      await db.execute("UPDATE lessons SET rule = 'boom'");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabasesError);
    expect(caught).toMatchObject({ code: "query", engineCode: "7500" });
  });

  it("says what to set when there is no token", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("PATH", "/nonexistent");
    const db = await open(`d1:${DATABASE}`);

    expect(await failure(db.query("SELECT 1"))).toBe("auth");
    expect(sent).toEqual([]);
  });
});
