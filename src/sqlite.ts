/**
 * Whole SQLite reads for programs: no cell, row or answer budget, and a deadline only when you
 * ask for one. The agent tools keep theirs. Same guard as every read: a read-only file and the
 * authorizer.
 */

import { DatabasesError } from "./core/errors.ts";
import { checkStatement } from "./core/provider.ts";
import { parseReference } from "./core/reference.ts";
import { runChild } from "./core/sqlite-protocol.ts";
import { fromWire, paramToWire } from "./core/sqlite-wire.ts";
import type { ReadOptions, ReadResult } from "./core/types.ts";

export type { ReadOptions, ReadResult, SqliteValue } from "./core/types.ts";

/** The longest deadline a timer can hold. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Reads one statement from a SQLite file and returns every value as SQLite stores it: text
 * uncut, blobs as bytes, integers past 2^53 as bigints. Runs in this process when the host has
 * `node:sqlite`, in a Node child process when it doesn't.
 *
 * In this process the deadline and the signal are checked every few hundred rows, so one long
 * step inside SQLite, such as a sort before the first row, finishes before either can stop it.
 *
 * @example
 *   ```ts
 *   const { rows, more } = await read("./sessions.db", {
 *     sql: "SELECT id, data FROM part WHERE time_created > ? ORDER BY time_created",
 *     params: [since],
 *     limit: 5000,
 *   });
 *   ```
 *
 * @param database - A SQLite path, `sqlite:<path>`, or a connection name set to one.
 * @param options - The statement, its parameters, and an optional limit, deadline and signal.
 * @returns {Promise<ReadResult>} Columns, rows, and whether rows past the limit were left.
 * @throws {DatabasesError} `config` without the file, `refused` for a write, `timeout` late.
 */
export async function read(database: string, options: Readonly<ReadOptions>): Promise<ReadResult> {
  const target = parseReference(database);
  if (target.provider !== "sqlite") {
    throw new DatabasesError(`read takes a SQLite file, not ${target.label}`, { code: "config" });
  }
  const job = {
    path: target.target,
    sql: options.sql,
    params: checkStatement(options.sql, options.params),
    limit: checkLimit(options.limit),
  };
  const timeoutMs = checkTimeout(options.timeoutMs);
  const { signal } = options;
  signal?.throwIfAborted();
  if (!process.getBuiltinModule("node:sqlite")) {
    const params = job.params.map((value) => paramToWire(value));
    const [answer] = await runChild({ kind: "read", ...job, params }, { signal, timeoutMs });
    if (!answer || !("wire" in answer)) return { columns: [], rows: [], more: false };
    const { columns, rows, more } = answer.wire;
    return { columns, rows: rows.map((row) => row.map((value) => fromWire(value))), more };
  }
  const { readRaw } = await import("./core/sqlite-raw.ts");
  const deadline = performance.now() + timeoutMs;
  /* Throws once the caller aborted or the deadline passed. */
  const check = (): void => {
    signal?.throwIfAborted();
    if (performance.now() > deadline) {
      throw new DatabasesError(`The read ran past ${timeoutMs / 1000} s and was stopped`, {
        code: "timeout",
        provider: "sqlite",
      });
    }
  };
  check();
  const result = await readRaw(job, {
    checkpoint: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      check();
    },
  });
  if (!signal && !Number.isFinite(timeoutMs)) return result;
  /* A timer turn, so an abort timer that came due during the last step fires first. */
  await new Promise((resolve) => setTimeout(resolve, 0));
  check();
  return result;
}

/**
 * A row limit: any positive integer, or none.
 *
 * @param limit - What the caller asked for.
 * @returns {number | undefined} The limit.
 * @throws {DatabasesError} `query` for anything else.
 */
function checkLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || (Number.isSafeInteger(limit) && limit > 0)) return limit;
  throw new DatabasesError("limit must be a positive integer, or left out for every row", {
    code: "query",
  });
}

/**
 * A deadline in milliseconds, `Infinity` for none.
 *
 * @param timeoutMs - What the caller asked for.
 * @returns {number} The deadline.
 * @throws {DatabasesError} `query` for anything but a positive number a timer can hold.
 */
function checkTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return Number.POSITIVE_INFINITY;
  if (typeof timeoutMs === "number" && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS) {
    return timeoutMs;
  }
  throw new DatabasesError(
    `timeoutMs must be a number from 1 to ${MAX_TIMEOUT_MS}, or left out for no deadline`,
    { code: "query" },
  );
}
