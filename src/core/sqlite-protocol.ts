/**
 * The job a SQLite child process runs, and how the parent starts it. The parent side imports no
 * `node:sqlite`, so the package loads in hosts that lack it, such as compiled OMP on Bun.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabasesError, type DatabasesErrorCode } from "./errors.ts";
import { STATEMENT_TIMEOUT_MS } from "./limits.ts";
import type { Cell, Column, Param } from "./types.ts";

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
    };

export type ChildResult =
  | {
      readonly columns: readonly Column[];
      readonly rows: readonly (readonly Cell[])[];
      readonly more: boolean;
      readonly cut: boolean;
    }
  | { readonly changes: number; readonly lastInsertId: string };

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
  /** Kill the child after this long. Default `STATEMENT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** Bytes of answer the parent reads before it gives up on a child. */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

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
    const child = spawn(nodeBinary(), ["--no-warnings", "--max-old-space-size=512", script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env["PATH"] ?? "", NODE_OPTIONS: "" },
    });
    const chunks: Uint8Array[] = [];
    const errors: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | undefined, results?: readonly ChildResult[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve([...(results ?? [])]);
    };
    const onAbort = (): void => {
      finish(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      finish(
        new DatabasesError(`The statement ran past ${timeoutMs / 1000} s and was stopped`, {
          code: "timeout",
          provider: "sqlite",
        }),
      );
    }, timeoutMs);
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
      if (size > MAX_ANSWER_BYTES) {
        finish(new DatabasesError("The SQLite answer was too large", { code: "query" }));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      if (errors.length < 16) errors.push(chunk);
    });
    child.on("close", (code) => {
      const text = Buffer.concat(chunks).toString("utf8");
      let answer: ChildAnswer;
      try {
        answer = JSON.parse(text) as ChildAnswer;
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
      } else finish(undefined, answer.results);
    });
    child.stdin.on("error", () => {
      /* A child that exits before reading its job reports through `close`. */
    });
    child.stdin.end(JSON.stringify(job));
  });
}
