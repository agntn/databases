/** The provider contract every engine implements, plus its registry metadata. */

import {
  DEFAULT_ROWS,
  DEFAULT_SAMPLE_ROWS,
  MAX_PARAMS,
  MAX_ROWS,
  MAX_SQL_LENGTH,
} from "./limits.ts";
import { DatabasesError } from "./errors.ts";
import type { DatabaseTarget } from "./reference.ts";
import type {
  ExecuteOptions,
  ExecuteResult,
  ExplainOptions,
  Param,
  PlanResult,
  QueryOptions,
  QueryResult,
  SampleOptions,
  SchemaOptions,
  TableDetail,
  TableSummary,
} from "./types.ts";

/** What the registry knows about a provider without loading it. */
export interface ProviderMeta {
  readonly key: string;
  readonly title: string;
  /** How a reference names this engine, for the listing. */
  readonly reference: string;
  /** How read-only is enforced, in one line. */
  readonly readOnly: string;
  /** Where the credentials come from, when the engine needs any beyond the reference. */
  readonly credentials?: string;
}

export interface ProviderEntry extends ProviderMeta {
  readonly load: () => Promise<ProviderConstructor>;
}

export type ProviderConstructor = new (target: DatabaseTarget) => Provider;

/**
 * One database behind one engine. Every read goes through the engine's read-only path; only
 * `execute` writes.
 */
export abstract class Provider {
  readonly target: DatabaseTarget;

  constructor(target: DatabaseTarget) {
    this.target = target;
  }

  /** Registry key. */
  abstract get key(): string;

  /**
   * Tables and views, system ones left out.
   * @param options - Cancellation.
   */
  abstract tables(options?: SchemaOptions): Promise<TableSummary[]>;

  /**
   * Columns, indexes and foreign keys of one table or view.
   * @param name - Table name, `schema.table` in Postgres.
   * @param options - Cancellation.
   */
  abstract table(name: string, options?: SchemaOptions): Promise<TableDetail>;

  /**
   * Runs one statement read-only and returns its first rows.
   * @param sql - One statement.
   * @param options - Parameters, row limit and cancellation.
   */
  abstract query(sql: string, options?: QueryOptions): Promise<QueryResult>;

  /**
   * The engine's plan for one statement, without running it.
   * @param sql - One statement.
   * @param options - Parameters and cancellation.
   */
  abstract explain(sql: string, options?: ExplainOptions): Promise<PlanResult>;

  /**
   * Runs one statement that may write.
   * @param sql - One statement.
   * @param options - Parameters and cancellation.
   */
  abstract execute(sql: string, options?: ExecuteOptions): Promise<ExecuteResult>;

  /**
   * Quotes a table name, `schema.table` included, for this engine.
   * @param name - Table name as `table` takes it.
   */
  protected abstract quoteTable(name: string): string;

  /**
   * The first rows of a table, without writing SQL.
   *
   * @param name - Table name, `schema.table` in Postgres.
   * @param options - Row limit and cancellation.
   * @returns {Promise<QueryResult>} The rows.
   */
  async sample(name: string, options: SampleOptions = {}): Promise<QueryResult> {
    const limit = rowLimit(options.limit, DEFAULT_SAMPLE_ROWS);
    return this.query(`SELECT * FROM ${this.quoteTable(name)}`, {
      limit,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

/**
 * A row limit inside `[1, MAX_ROWS]`.
 *
 * @param limit - Requested limit, if any.
 * @param fallback - Limit when none was requested.
 * @returns {number} The limit to apply.
 * @throws {DatabasesError} For a non-integer or out-of-range limit.
 */
export function rowLimit(limit: number | undefined, fallback: number = DEFAULT_ROWS): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) {
    throw new DatabasesError(`limit must be an integer from 1 to ${MAX_ROWS}`, { code: "query" });
  }
  return limit;
}

/**
 * Checks a statement and its parameters before anything is sent.
 *
 * @param sql - Statement text.
 * @param params - Bind parameters, if any.
 * @returns {Param[]} The parameters as a fresh array.
 * @throws {DatabasesError} For an empty or oversized statement, or an unusable parameter.
 */
export function checkStatement(sql: string, params: readonly Param[] | undefined): Param[] {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new DatabasesError("No statement to run", { code: "query" });
  }
  if (sql.length > MAX_SQL_LENGTH) {
    throw new DatabasesError(`The statement is longer than ${MAX_SQL_LENGTH} characters`, {
      code: "query",
    });
  }
  const list: unknown = params ?? [];
  if (!Array.isArray(list) || list.length > MAX_PARAMS) {
    throw new DatabasesError(`params must be an array of at most ${MAX_PARAMS} values`, {
      code: "query",
    });
  }
  if (!list.every((value) => isParam(value))) {
    throw new DatabasesError("Each parameter is a string, a finite number, a boolean or null", {
      code: "query",
    });
  }
  return [...list];
}

/**
 * Tells a usable bind parameter from anything else a caller without types might pass.
 *
 * @param value - One parameter.
 * @returns {value is Param} Whether every engine can bind it.
 */
function isParam(value: unknown): value is Param {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** One part of a name: quoted with `""` for a quote inside, or bare up to a dot. */
const PART = String.raw`\s*("(?:[^"]|"")*"|[^."]+?)\s*`;
const NAME = new RegExp(`^${PART}(?:\\.${PART})?$`, "u");

export interface NamePart {
  readonly text: string;
  /** Written in double quotes, so the engine takes its case as is. */
  readonly quoted: boolean;
}

/**
 * Splits `schema.table` the way a caller writes it, honoring double quotes.
 *
 * @param name - `table`, `schema.table`, `"Mixed Case"` or `"a.b"."c"`.
 * @returns {NamePart[]} One or two parts, quotes removed.
 * @throws {DatabasesError} For an empty name, more than two parts or an open quote.
 */
export function nameParts(name: string): NamePart[] {
  const match = NAME.exec(name);
  const parts = match ? [match[1], match[2]].filter((part) => part !== undefined) : [];
  if (parts.length === 0 || parts.includes('""')) {
    throw new DatabasesError(
      `Can't read the table name ${JSON.stringify(name)}. Write table, schema.table, or quote a part with "`,
      { code: "query" },
    );
  }
  return parts.map((part) =>
    part.startsWith('"')
      ? { text: part.slice(1, -1).replaceAll('""', '"'), quoted: true }
      : { text: part, quoted: false },
  );
}

/**
 * The parts of a table name as plain text.
 *
 * @param name - As `nameParts` takes it.
 * @returns {string[]} One or two parts.
 */
export function splitName(name: string): string[] {
  return nameParts(name).map((part) => part.text);
}

/**
 * One identifier in double quotes, inner quotes doubled.
 *
 * @param part - Identifier.
 * @returns {string} The quoted identifier.
 */
export function quoteIdentifier(part: string): string {
  return `"${part.replaceAll('"', '""')}"`;
}
