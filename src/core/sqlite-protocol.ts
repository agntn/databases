/**
 * The job a SQLite child process runs, and how the parent starts it. The parent side imports no
 * `node:sqlite`, so the package loads in hosts that lack it, such as compiled OMP on Bun.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabasesError, type DatabasesErrorCode } from "./errors.ts";
import { STATEMENT_TIMEOUT_MS } from "./limits.ts";
import type { MigrationScript } from "./migration-table.ts";
import type { Cell, Column, Param } from "./types.ts";
import type { WireValue } from "./sqlite-wire.ts";

export interface ChildStep {
  readonly sql: string;
  readonly params: readonly Param[];
  /** Rows to read; the child reads one more to tell whether there are more. */
  readonly limit?: number;
  /** Run for the changes instead of reading rows. */
  readonly run?: boolean;
}

export type ChildJob =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly write: boolean;
      readonly steps: readonly ChildStep[];
    }
  | {
      readonly kind: "check";
      /** `CREATE` statements of the remote schema. */
      readonly schema: readonly string[];
      readonly sql: string;
      readonly write: boolean;
    }
  | {
      /** Runs a migration and its record in one transaction, or rolls both back. */
      readonly kind: "migrate";
      readonly path: string;
      readonly script: MigrationScript;
    }
  | {
      /** One read with every value whole, for `read` on a host without `node:sqlite`. */
      readonly kind: "read";
      readonly path: string;
      readonly sql: string;
      /** Tagged by `paramToWire`, since JSON drops the sign of `-0`. */
      readonly params: readonly (WireValue | boolean)[];
      readonly limit?: number | undefined;
    };

export type ChildResult =
  | {
      readonly columns: readonly Column[];
      readonly rows: readonly (readonly Cell[])[];
      readonly more: boolean;
      readonly cut: boolean;
    }
  | { readonly changes: number; readonly lastInsertId: string }
  | {
      /** `false` when the table already had it, so nothing ran. */
      readonly applied: boolean;
    }
  | {
      /** A whole read; its rows arrive as lines before it. */
      readonly wire: {
        readonly columns: readonly Column[];
        readonly rows: readonly (readonly WireValue[])[];
        readonly more: boolean;
      };
    };

export type ChildAnswer =
  | { readonly results: readonly ChildResult[] }
  | {
      readonly error: {
        readonly message: string;
        readonly code: DatabasesErrorCode;
        readonly engineCode?: string;
      };
    };

export interface RunOptions {
  readonly signal?: AbortSignal | undefined;
  /** Kill the child after this long, `Infinity` for never. Default `STATEMENT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** Bytes of answer the parent reads before it gives up on a child. A whole read has no cap. */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

/**
 * Node flags for a job. A whole read gets the default heap, since its size is the caller's call.
 *
 * @param job - The work.
 * @returns {string[]} Flags before the script.
 */
function nodeFlags(job: ChildJob): string[] {
  return job.kind === "read" ? ["--no-warnings"] : ["--no-warnings", "--max-old-space-size=512"];
}

/** Reads the child's answer line by line, so a whole read never needs one string for all rows. */
class AnswerReader {
  /** Every full line so far: the rows of a whole read, none for other jobs. */
  readonly rows: WireValue[][] = [];
  #pending: Uint8Array[] = [];

  /**
   * Takes one chunk of stdout.
   *
   * @param chunk - The bytes.
   */
  push(chunk: Uint8Array): void {
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      this.#pending.push(chunk.subarray(start, end));
      this.rows.push(JSON.parse(Buffer.concat(this.#pending).toString("utf8")) as WireValue[]);
      this.#pending = [];
      start = end + 1;
    }
    if (start < chunk.length) this.#pending.push(chunk.subarray(start));
  }

  /**
   * The last line, which is the answer itself.
   *
   * @returns {string} Its text.
   */
  rest(): string {
    return Buffer.concat(this.#pending).toString("utf8");
  }
}

/**
 * The child script: `dist/sqlite-child.mjs` beside the chunks of a build, `src/sqlite-child.ts`
 * in a checkout. Chunks sit one level under `dist/` as providers sit under `src/`.
 *
 * @returns {string} Absolute path of the script.
 * @throws {DatabasesError} When neither is there.
 */
function childScript(): string {
  const candidates = import.meta.url.endsWith(".ts")
    ? ["../sqlite-child.ts", "./sqlite-child.ts"]
    : ["../sqlite-child.mjs", "./sqlite-child.mjs"];
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new DatabasesError("The SQLite runner is missing from this install", {
    code: "unsupported",
  });
}

/**
 * The Node binary to run the child with. Bun has no `node:sqlite`, so a Bun host asks for `node`.
 *
 * @returns {string} Path or command name.
 */
function nodeBinary(): string {
  return "bun" in process.versions ? "node" : process.execPath;
}

/**
 * Puts the rows that came as lines into the whole read they belong to.
 *
 * @param results - What the last line said.
 * @param rows - The lines before it.
 * @returns {ChildResult[]} The results, rows in place.
 */
function withRows(
  results: readonly ChildResult[],
  rows: readonly (readonly WireValue[])[],
): ChildResult[] {
  return results.map((result) => ("wire" in result ? { wire: { ...result.wire, rows } } : result));
}

/**
 * Runs a job in a fresh Node process and kills it at the deadline or on abort.
 *
 * @param job - The work.
 * @param options - Cancellation, and a deadline other than `STATEMENT_TIMEOUT_MS`.
 * @returns {Promise<ChildResult[]>} One result per step.
 * @throws {DatabasesError} The child's own failure, `timeout`, or `unsupported` without Node.
 */
export function runChild(
  job: ChildJob,
  options: Readonly<RunOptions> = {},
): Promise<ChildResult[]> {
  const { signal, timeoutMs = STATEMENT_TIMEOUT_MS } = options;
  signal?.throwIfAborted();
  const script = childScript();
  return new Promise((resolve, reject) => {
    const cap = job.kind === "read" ? Number.POSITIVE_INFINITY : MAX_ANSWER_BYTES;
    const child = spawn(nodeBinary(), [...nodeFlags(job), script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env["PATH"] ?? "", NODE_OPTIONS: "" },
    });
    const reader = new AnswerReader();
    const errors: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | undefined, results?: readonly ChildResult[]): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve([...(results ?? [])]);
    };
    const onAbort = (): void => {
      finish(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          finish(
            new DatabasesError(`The statement ran past ${timeoutMs / 1000} s and was stopped`, {
              code: "timeout",
              provider: "sqlite",
            }),
          );
        }, timeoutMs)
      : undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      finish(
        new DatabasesError(`Can't start node for SQLite: ${error.message}`, {
          code: "unsupported",
          provider: "sqlite",
          cause: error,
        }),
      );
    });
    child.stdout.on("data", (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > cap) {
        finish(new DatabasesError("The SQLite answer was too large", { code: "query" }));
        return;
      }
      try {
        reader.push(chunk);
      } catch {
        finish(new DatabasesError("The SQLite runner sent a broken row", { code: "query" }));
      }
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      if (errors.length < 16) errors.push(chunk);
    });
    child.on("close", (code) => {
      let answer: ChildAnswer;
      try {
        answer = JSON.parse(reader.rest()) as ChildAnswer;
      } catch {
        const detail = Buffer.concat(errors).toString("utf8").trim().split("\n").at(-1) ?? "";
        finish(
          new DatabasesError(
            `The SQLite runner stopped (exit ${String(code)})${detail ? `: ${detail}` : ""}`,
            { code: "query", provider: "sqlite" },
          ),
        );
        return;
      }
      if ("error" in answer) {
        finish(
          new DatabasesError(answer.error.message, {
            code: answer.error.code,
            provider: "sqlite",
            ...(answer.error.engineCode ? { engineCode: answer.error.engineCode } : {}),
          }),
        );
      } else finish(undefined, withRows(answer.results, reader.rows));
    });
    child.stdin.on("error", () => {
      /* A child that exits before reading its job reports through `close`. */
    });
    child.stdin.end(JSON.stringify(job));
  });
}
