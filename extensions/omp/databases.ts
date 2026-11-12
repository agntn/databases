import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { registerOmpTools, type OmpResultView } from "@agntn/tools/omp";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import type * as DatabasesTools from "../../dist/tools.d.mts";

/** Longest argument on the status line, cut before `sanitizeLine`, which is slow on long escapes. */
const PREVIEW_LENGTH = 60;

const sourceModulePath = fileURLToPath(new URL("../../src/tools.ts", import.meta.url));

/**
 * Both specifiers stay literal: compiled OMP resolves bare imports only where it sees them.
 *
 * @returns {Promise<typeof DatabasesTools>} The definitions and the executor loader.
 */
function loadTools(): Promise<typeof DatabasesTools> {
  return (
    existsSync(sourceModulePath) ? import("../../src/tools.ts") : import("../../dist/tools.mjs")
  ) as Promise<typeof DatabasesTools>;
}

/**
 * The start of a string argument, or nothing.
 *
 * @param value - Raw argument.
 * @returns {string} Up to `PREVIEW_LENGTH` characters.
 */
function preview(value: unknown): string {
  if (typeof value !== "string") return "";
  const flat = value.replaceAll(/\s+/gu, " ").trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat;
}

/**
 * Database and the start of the statement or table.
 *
 * @param args - Raw arguments.
 * @returns {string} The summary.
 */
function describeStatement(args: Readonly<Record<string, unknown>>): string {
  return [preview(args["database"]), preview(args["table"] ?? args["sql"])]
    .filter(Boolean)
    .join(" ");
}

/**
 * Row count and whether more rows exist, for a result that has rows.
 *
 * @param result - Tool result from the host.
 * @returns {string[]} One entry per fact.
 */
function describeRows(result: OmpResultView): string[] {
  const { details } = result;
  if (typeof details !== "object" || details === null || !("rows" in details)) return [];
  const { rows, more } = details as { rows?: unknown; more?: unknown };
  if (!Array.isArray(rows)) return [];
  return [`${rows.length} rows`, ...(more === true ? ["more"] : [])];
}

/**
 * Registers the databases tools; the executors load on the first call.
 *
 * @param pi - OMP extension API supplied by the host.
 */
export default async function databasesExtension(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("Databases");
  const { databasesTools } = await loadTools();
  registerOmpTools(pi, databasesTools, {
    Text: pi.pi.Text,
    renderers: {
      databases_schema_get: { describeCall: describeStatement },
      databases_table_sample: { describeCall: describeStatement, describeResult: describeRows },
      databases_query: { describeCall: describeStatement, describeResult: describeRows },
      databases_explain: { describeCall: describeStatement },
      databases_execute: { describeCall: describeStatement },
    },
  });
}
