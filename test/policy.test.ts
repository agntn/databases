import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { DatabasesError } from "../src/core/errors.ts";
import { guardReads, prepareOne } from "../src/core/policy.ts";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE t (a, b); INSERT INTO t VALUES (1, 2); CREATE VIRTUAL TABLE f USING fts5(x);",
  );
  guardReads(db);
});

afterEach(() => {
  db.close();
});

/**
 * The code a statement fails with, or `ok`.
 */
function verdict(sql: string): string {
  try {
    prepareOne(db, sql, "read");
    return "ok";
  } catch (error) {
    return error instanceof DatabasesError ? error.code : "other";
  }
}

describe("the SQLite read guard", () => {
  it.each([
    "SELECT * FROM t",
    "WITH x AS (SELECT a FROM t) SELECT * FROM x",
    "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c LIMIT 5) SELECT * FROM c",
    "SELECT json_object('a', 1), lower('X'), count(*) FROM t",
    "PRAGMA table_info(t)",
    "SELECT * FROM pragma_table_info('t')",
    "PRAGMA user_version",
    "PRAGMA journal_mode",
    "PRAGMA integrity_check",
    "SELECT * FROM f WHERE f MATCH 'x'",
    "EXPLAIN QUERY PLAN SELECT * FROM t",
    "SELECT 1;",
    "SELECT 1; -- trailing note",
    "SELECT 1; /* note */ ;",
  ])("lets %s through", (sql) => {
    expect(verdict(sql)).toBe("ok");
  });

  it.each([
    "INSERT INTO t VALUES (3, 4)",
    "UPDATE t SET a = 0",
    "DELETE FROM t",
    "REPLACE INTO t VALUES (1, 1)",
    "WITH x AS (SELECT 1) DELETE FROM t",
    "CREATE TABLE u (a)",
    "CREATE TEMP TABLE u (a)",
    "DROP TABLE t",
    "ALTER TABLE t ADD COLUMN c",
    "CREATE INDEX i ON t (a)",
    "ATTACH 'other.db' AS o",
    "DETACH main",
    "PRAGMA user_version = 5",
    "PRAGMA journal_mode = wal",
    "PRAGMA writable_schema = 1",
    "PRAGMA foreign_keys = off",
    "BEGIN",
    "SAVEPOINT s",
    "VACUUM",
    "VACUUM INTO '/tmp/copy.db'",
    "/* note */ vacuum main into 'copy.db'",
    "ANALYZE",
    "REINDEX",
    "SELECT load_extension('evil')",
    "EXPLAIN QUERY PLAN DELETE FROM t",
    "INSERT INTO f VALUES ('x')",
  ])("refuses %s", (sql) => {
    expect(verdict(sql)).toBe("refused");
  });

  it.each([
    "SELECT 1; DELETE FROM t",
    "SELECT 1; SELECT 2",
    "SELECT 1; -- c\nDELETE FROM t",
    "SELECT 1; /* c */ DELETE FROM t",
    "SELECT ';'; DELETE FROM t",
  ])("refuses a second statement in %j", (sql) => {
    expect(verdict(sql)).toBe("refused");
  });

  it("reports SQL the engine can't read as a query error", () => {
    expect(verdict("SELEC 1")).toBe("query");
    expect(verdict("SELECT * FROM missing")).toBe("query");
    expect(verdict("   ")).toBe("query");
  });

  it("leaves writes alone in write mode but still takes one statement", () => {
    const writer = new DatabaseSync(":memory:");
    writer.exec("CREATE TABLE t (a)");
    expect(() => prepareOne(writer, "INSERT INTO t VALUES (1)", "write")).not.toThrow();
    expect(() => prepareOne(writer, "INSERT INTO t VALUES (1); DROP TABLE t", "write")).toThrow(
      /one statement per call/u,
    );
    writer.close();
  });
});
