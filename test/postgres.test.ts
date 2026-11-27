/**
 * Runs against a real Postgres named by DATABASES_TEST_POSTGRES_URL, a role that may create
 * tables; CI starts one as a service. Without it the suite is skipped.
 */

import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { DatabasesError } from "../src/core/errors.ts";
import type { Provider } from "../src/core/provider.ts";
import { open } from "../src/core/registry.ts";
import { postgresUrl } from "./helpers.ts";

const SCHEMA = "databases_test";

/** The code a call rejects with. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof DatabasesError ? error.code : String(error);
  }
}

describe.skipIf(!postgresUrl)("the postgres provider", () => {
  const url = postgresUrl ?? "";
  let db: Provider;
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    await admin.unsafe(
      `CREATE TABLE ${SCHEMA}.customers (id serial PRIMARY KEY, name text NOT NULL)`,
    );
    await admin.unsafe(
      `CREATE TABLE ${SCHEMA}."Orders" (id serial PRIMARY KEY, customer_id int REFERENCES ${SCHEMA}.customers (id), total numeric(10,2), note text)`,
    );
    await admin.unsafe(`CREATE INDEX orders_customer ON ${SCHEMA}."Orders" (customer_id)`);
    await admin.unsafe(`INSERT INTO ${SCHEMA}.customers (name) VALUES ('Ada'), ('Linus')`);
    await admin.unsafe(
      `INSERT INTO ${SCHEMA}."Orders" (customer_id, total, note) VALUES (1, 12.5, 'a'), (1, 3, E'line\\nbreak'), (2, 99.99, NULL)`,
    );
    db = await open(url);
  });

  afterAll(async () => {
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it("lists tables with their schema", async () => {
    const tables = await db.tables();
    expect(tables).toEqual(
      expect.arrayContaining([
        { schema: SCHEMA, name: "customers", kind: "table" },
        { schema: SCHEMA, name: "Orders", kind: "table" },
      ]),
    );
  });

  it("describes a table, quoted names included", async () => {
    const table = await db.table(`${SCHEMA}."Orders"`);
    expect(table).toMatchObject({ schema: SCHEMA, name: "Orders" });
    expect(table.columns[0]).toMatchObject({
      name: "id",
      type: "integer",
      nullable: false,
      primaryKey: 1,
    });
    expect(table.columns[2]).toMatchObject({
      name: "total",
      type: "numeric(10,2)",
      nullable: true,
    });
    expect(table.indexes.map((index) => index.name)).toContain("orders_customer");
    expect(table.foreignKeys).toEqual([
      { columns: ["customer_id"], table: `${SCHEMA}.customers`, references: ["id"] },
    ]);
    expect((await db.table(`${SCHEMA}.CUSTOMERS`)).name).toBe("customers");
    expect(await failure(db.table(`${SCHEMA}.missing`))).toBe("query");
  });

  it("reads rows with types and parameters, numerics as exact text", async () => {
    const result = await db.query(
      `SELECT id, total, note FROM ${SCHEMA}."Orders" WHERE total > $1 ORDER BY id`,
      { params: [5] },
    );
    expect(result.columns).toEqual([
      { name: "id", type: "integer" },
      { name: "total", type: "numeric" },
      { name: "note", type: "text" },
    ]);
    expect(result.rows).toEqual([
      [1, "12.50", "a"],
      [3, "99.99", null],
    ]);
  });

  it("keeps duplicate column names apart", async () => {
    expect((await db.query("SELECT 1 AS a, 2 AS a")).rows).toEqual([[1, 2]]);
  });

  it("stops at the limit without reading the rest", async () => {
    const result = await db.query("SELECT g FROM generate_series(1, 1000000) AS g", { limit: 3 });
    expect(result).toMatchObject({ rows: [[1], [2], [3]], more: true });
  });

  it.each([
    `DELETE FROM ${SCHEMA}.customers`,
    `WITH d AS (DELETE FROM ${SCHEMA}.customers RETURNING *) SELECT * FROM d`,
    `SELECT 1; DELETE FROM ${SCHEMA}.customers`,
    `CREATE TABLE ${SCHEMA}.x (a int)`,
  ])("refuses %j", async (sql) => {
    expect(await failure(db.query(sql))).toBe("refused");
    expect(await admin.unsafe(`SELECT count(*)::int AS n FROM ${SCHEMA}.customers`)).toEqual([
      { n: 2 },
    ]);
  });

  it("reports a cancelled statement as a timeout", async () => {
    /* 57014 is what statement_timeout raises; cancelling itself gets there without waiting 30 s. */
    expect(await failure(db.query("SELECT pg_cancel_backend(pg_backend_pid()), pg_sleep(1)"))).toBe(
      "timeout",
    );
  });

  it.each([
    `SELECT 1; COMMIT; SET default_transaction_read_only = off; DELETE FROM ${SCHEMA}.customers`,
    `SELECT 1; COMMIT`,
  ])("refuses a second command after EXPLAIN too: %j", async (sql) => {
    expect(await failure(db.explain(sql))).toBe("refused");
    expect(await admin.unsafe(`SELECT count(*)::int AS n FROM ${SCHEMA}.customers`)).toEqual([
      { n: 2 },
    ]);
  });

  it("explains without running", async () => {
    const plan = await db.explain(`SELECT * FROM ${SCHEMA}.customers WHERE id = $1`, {
      params: [1],
    });
    expect(plan.lines.join("\n")).toMatch(/Scan/u);
    expect(await failure(db.explain(`ANALYZE DELETE FROM ${SCHEMA}.customers`))).not.toBe(
      "resolved",
    );
  });

  it("samples by name, folding an unquoted name to lower case", async () => {
    expect((await db.sample(`${SCHEMA}.Customers`, { limit: 1 })).rows).toEqual([[1, "Ada"]]);
  });

  it("writes through execute in its own transaction", async () => {
    expect(
      await db.execute(`UPDATE ${SCHEMA}."Orders" SET note = $1 WHERE id = $2`, {
        params: ["x", 3],
      }),
    ).toEqual({ changes: 1 });
    expect(
      await failure(
        db.execute(`UPDATE ${SCHEMA}."Orders" SET note = 'y'; DROP TABLE ${SCHEMA}.customers`),
      ),
    ).toBe("refused");
  });

  it("hides the password when the database can't be reached", async () => {
    const parsed = new URL(url);
    parsed.port = "1";
    parsed.password = "do-not-show-me";
    const unreachable = await open(parsed.toString());
    let message = "";
    try {
      await unreachable.query("SELECT 1");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
      expect((error as DatabasesError).code).toBe("connection");
    }
    expect(message).toContain("***");
    expect(message).not.toContain("do-not-show-me");
  });
});

describe.skipIf(!postgresUrl)("the CLI against postgres", () => {
  it("refuses two statements in one line on stderr", () => {
    const { status, stderr } = spawnSync(
      process.execPath,
      ["src/cli.ts", "query", postgresUrl ?? "", "SELECT 1; SELECT 2"],
      { encoding: "utf8" },
    );
    expect({ status, stderr }).toEqual({
      status: 1,
      stderr:
        "Refused: send one statement per call. Everything after the first `;` would have run too [refused]\n",
    });
  });
});
