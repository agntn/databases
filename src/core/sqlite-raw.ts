/**
 * Reads a SQLite file with nothing shortened: every cell whole, every row up to the caller's
 * limit. Imports `node:sqlite`, so only a host that has it loads this module.
 */

import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DatabasesError } from "./errors.ts";
import { guardReads, prepareOne } from "./policy.ts";
import type { Column, Param, ReadResult, SqliteValue } from "./types.ts";

export interface RawRead {
  readonly path: string;
  readonly sql: string;
  readonly params: readonly Param[];
  /** Most rows to read, none for all of them. */
  readonly limit?: number | undefined;
}

/** Rows read between two checkpoints. */
const CHECK_EVERY = 256;

/**
 * Column names and declared types of a prepared statement.
 *
 * @param statement - Prepared statement.
 * @returns {Column[]} One entry per result column.
 */
export function columnsOf(statement: StatementSync): Column[] {
  return statement.columns().map((column) => ({
    name: column.name,
    ...(column.type ? { type: column.type.toLowerCase() } : {}),
  }));
}

/**
 * Opens an existing file read-only, with the read guard installed.
 *
 * @param path - The file.
 * @returns {DatabaseSync} The connection.
 * @throws {DatabasesError} `config` when there is no file, so none gets created.
 */
function openRead(path: string): DatabaseSync {
  if (!existsSync(path)) throw new DatabasesError(`No SQLite file at ${path}`, { code: "config" });
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  db.enableDefensive(true);
  guardReads(db);
  return db;
}

/**
 * A bigint as a number while that stays exact.
 *
 * @param value - What the driver returned.
 * @returns {SqliteValue} The value.
 */
function exact(value: unknown): SqliteValue {
  if (typeof value !== "bigint") return value as SqliteValue;
  const safe = value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER;
  return safe ? Number(value) : value;
}

/**
 * Runs one read and keeps every value whole.
 *
 * @param job - File, statement, parameters and limit.
 * @param checkpoint - Awaited every few hundred rows, so the caller can yield, cancel or stop.
 * @returns {Promise<ReadResult>} The rows.
 * @throws {DatabasesError} `refused` for a write, `query` for what the engine rejects.
 */
export async function readRaw(
  job: Readonly<RawRead>,
  checkpoint: () => Promise<void>,
): Promise<ReadResult> {
  let db: DatabaseSync | undefined;
  try {
    db = openRead(job.path);
    const statement = prepareOne(db, job.sql, "read");
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    /* SQLite has no boolean type; it stores true and false as 1 and 0. */
    const params = job.params.map((value) => (typeof value === "boolean" ? Number(value) : value));
    const rows: SqliteValue[][] = [];
    let more = false;
    for (const row of statement.iterate(...params) as Iterable<unknown[]>) {
      if (rows.length === job.limit) {
        more = true;
        break;
      }
      rows.push(row.map((value) => exact(value)));
      if (rows.length % CHECK_EVERY === 0) await checkpoint();
    }
    return { columns: columnsOf(statement), rows, more };
  } catch (error) {
    throw engineError(error);
  } finally {
    db?.close();
  }
}

/**
 * A SQLite failure as a `query` error; anything else, an abort reason included, as thrown.
 *
 * @param error - What was thrown.
 * @returns {unknown} The error to rethrow.
 */
function engineError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("errstr" in error)) return error;
  const message = error instanceof Error ? error.message : "SQLite failed";
  return new DatabasesError(message, {
    code: "query",
    provider: "sqlite",
    engineCode: String((error as { errstr: unknown }).errstr),
    cause: error,
  });
}
