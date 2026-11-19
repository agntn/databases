/**
 * Runs SQLite work in its own Node process, one job per process.
 *
 * `node:sqlite` is synchronous, and neither a worker's `terminate()` nor anything else stops a
 * statement inside `sqlite3_step`. Run in the caller's process, one runaway query would freeze
 * every other tool of the server. Here the parent kills the process at the deadline instead.
 *
 * Reads one JSON job from stdin and writes one JSON answer to stdout.
 */

import { existsSync } from "node:fs";
import { constants, DatabaseSync, type StatementSync } from "node:sqlite";
import { DatabasesError } from "./core/errors.ts";
import {
  alreadyApplied,
  createMigrationTable,
  MIGRATION_TABLE,
  recordMigration,
} from "./core/migration-table.ts";
import { guardReads, prepareOne } from "./core/policy.ts";
import type { ChildAnswer, ChildJob, ChildResult, ChildStep } from "./core/sqlite-protocol.ts";
import type { Cell, Column } from "./core/types.ts";
import { fitRows, toCell, type CellBudget } from "./core/values.ts";

/**
 * Collects stdin.
 *
 * @returns {Promise<string>} Everything the parent wrote.
 */
async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Column names and declared types of a prepared statement.
 *
 * @param statement - Prepared statement.
 * @returns {Column[]} One entry per result column.
 */
function columnsOf(statement: StatementSync): Column[] {
  return statement.columns().map((column) => ({
    name: column.name,
    ...(column.type ? { type: column.type.toLowerCase() } : {}),
  }));
}

/**
 * Runs one step: reads its first rows, or runs it for its changes.
 *
 * @param db - Open connection.
 * @param step - Statement, parameters and limit.
 * @param write - Whether the connection may write.
 * @returns {ChildResult} Rows or changes.
 */
function runStep(db: DatabaseSync, step: ChildStep, write: boolean): ChildResult {
  const statement = prepareOne(db, step.sql, write ? "write" : "read");
  statement.setReadBigInts(true);
  /* SQLite has no boolean type; it stores true and false as 1 and 0. */
  const params = step.params.map((value) => (typeof value === "boolean" ? Number(value) : value));
  if (step.run) {
    const outcome = statement.run(...params);
    return {
      changes: Number(outcome.changes),
      lastInsertId: String(outcome.lastInsertRowid),
    };
  }
  statement.setReturnArrays(true);
  const budget: CellBudget = { cut: false };
  const limit = step.limit ?? 1;
  const rows: Cell[][] = [];
  let more = false;
  for (const row of statement.iterate(...params) as Iterable<unknown[]>) {
    if (rows.length === limit) {
      more = true;
      break;
    }
    rows.push(row.map((value) => toCell(value, budget)));
  }
  const kept = fitRows(rows, budget);
  return { columns: columnsOf(statement), rows: kept, more, cut: budget.cut };
}

/**
 * Runs a job against a file.
 *
 * @param job - Path, mode and steps.
 * @returns {ChildResult[]} One result per step.
 */
function runFile(job: Extract<ChildJob, { kind: "file" }>): ChildResult[] {
  if (!existsSync(job.path)) {
    throw new DatabasesError(`No SQLite file at ${job.path}`, { code: "config" });
  }
  const db = new DatabaseSync(job.path, {
    readOnly: !job.write,
    timeout: 5000,
    enableForeignKeyConstraints: true,
  });
  try {
    db.enableDefensive(true);
    if (!job.write) guardReads(db);
    return job.steps.map((step) => runStep(db, step, job.write));
  } finally {
    db.close();
  }
}

/**
 * Prepares a statement against an empty copy of a schema, for an engine without a read-only mode.
 * Creating the copy runs unguarded; the statement itself is prepared under the read guard.
 *
 * @param job - The schema statements and the statement to check.
 * @returns {ChildResult[]} The statement's columns, with declared types where the copy knows them.
 */
function runCheck(job: Extract<ChildJob, { kind: "check" }>): ChildResult[] {
  const db = new DatabaseSync(":memory:");
  try {
    for (const create of job.schema) {
      try {
        db.exec(create);
      } catch {
        /* An object the local SQLite can't build, such as a D1-only module, is left out. */
      }
    }
    if (!job.write) guardReads(db);
    const statement = prepareOne(db, job.sql, job.write ? "write" : "read");
    return [{ columns: columnsOf(statement), rows: [], more: false, cut: false }];
  } finally {
    db.close();
  }
}

/**
 * Opens a file for writing, with the same settings `execute` gets.
 *
 * @param path - The file.
 * @returns {DatabaseSync} The connection.
 */
function openWritable(path: string): DatabaseSync {
  if (!existsSync(path)) throw new DatabasesError(`No SQLite file at ${path}`, { code: "config" });
  const db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true });
  db.enableDefensive(true);
  return db;
}

/**
 * Denies BEGIN, COMMIT and ROLLBACK, which would split a migration from its record.
 *
 * @param action - SQLite action code.
 * @returns {number} `SQLITE_DENY` for transaction control, `SQLITE_OK` for the rest.
 */
function denyTransactions(action: number): number {
  return action === constants.SQLITE_TRANSACTION ? constants.SQLITE_DENY : constants.SQLITE_OK;
}

/**
 * Runs the file's SQL with transaction control denied, naming that denial for what it is.
 *
 * @param db - Connection inside the migration's transaction.
 * @param sql - The whole file.
 */
function runScript(db: DatabaseSync, sql: string): void {
  db.setAuthorizer(denyTransactions);
  try {
    db.exec(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw /not authorized/iu.test(message)
      ? new DatabasesError(
          "Refused: the migration opens or ends a transaction. Each file already runs in one transaction with its record, so drop its BEGIN, COMMIT and ROLLBACK",
          { code: "refused", cause: error },
        )
      : error;
  } finally {
    db.setAuthorizer(null);
  }
}

/**
 * Runs one migration and its record in one transaction. A failure rolls both back.
 *
 * @param job - The file and the script.
 * @returns {ChildResult[]} Whether it ran, `false` when the table already had it.
 */
function runMigrate(job: Extract<ChildJob, { kind: "migrate" }>): ChildResult[] {
  const db = openWritable(job.path);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(createMigrationTable());
      const { name, checksum, sql, appliedAt } = job.script;
      const row = db.prepare(`SELECT checksum FROM ${MIGRATION_TABLE} WHERE name = ?`).get(name);
      const done = alreadyApplied(
        job.script,
        row === undefined ? undefined : String(row["checksum"]),
      );
      if (!done) {
        runScript(db, sql);
        db.prepare(recordMigration("?")).run(name, checksum, appliedAt);
      }
      db.exec("COMMIT");
      return [{ applied: !done }];
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * Turns any failure into an answer the parent can rethrow.
 *
 * @param error - What was thrown.
 * @returns {ChildAnswer} The failure.
 */
function failure(error: unknown): ChildAnswer {
  if (error instanceof DatabasesError) {
    return {
      error: {
        message: error.message,
        code: error.code,
        ...(error.engineCode ? { engineCode: error.engineCode } : {}),
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const engineCode =
    typeof error === "object" && error !== null && "errstr" in error
      ? String((error as { errstr: unknown }).errstr)
      : undefined;
  return { error: { message, code: "query", ...(engineCode ? { engineCode } : {}) } };
}

/**
 * Sends a job to the runner of its kind.
 *
 * @param job - What the parent wrote.
 * @returns {ChildResult[]} The results.
 */
function run(job: ChildJob): ChildResult[] {
  if (job.kind === "check") return runCheck(job);
  if (job.kind === "migrate") return runMigrate(job);
  return runFile(job);
}

let answer: ChildAnswer;
try {
  const job = JSON.parse(await readInput()) as ChildJob;
  answer = { results: run(job) };
} catch (error) {
  answer = failure(error);
}
process.stdout.write(JSON.stringify(answer));
