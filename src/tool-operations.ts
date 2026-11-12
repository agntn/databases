/**
 * Tool executors behind the definitions in `tools.ts`, loaded on the first call.
 *
 * Each executor returns the text a caller reads plus the structured details the agent harnesses
 * attach to the call. An MCP client sees only the text, so every fact a follow-up call needs is
 * in it. Everything that came from a database, names included, is escaped before it is printed:
 * a cell holding a newline or a bidi control must not pass for another row of the answer.
 */

import { sanitizeLine } from "@agntn/tools";
import { DatabasesError } from "./core/errors.ts";
import { MAX_ROWS } from "./core/limits.ts";
import type { Provider } from "./core/provider.ts";
import { listConnections, type NamedConnection } from "./core/reference.ts";
import { listProviders as listRegistered, open } from "./core/registry.ts";
import type { ProviderMeta } from "./core/provider.ts";
import type {
  Column,
  ColumnInfo,
  ExecuteResult,
  Param,
  PlanResult,
  QueryResult,
  TableDetail,
  TableSummary,
} from "./core/types.ts";

/**
 * Text for the model plus details for the harness, shared by every tool surface.
 * A failure throws instead: Pi records every returned value as a successful call.
 */
export interface ToolResult<Details> {
  content: Array<{ type: "text"; text: string }>;
  details: Details;
}

interface DatabaseInput {
  readonly database: string;
}

interface StatementInput extends DatabaseInput {
  readonly sql: string;
  readonly params?: readonly Param[];
}

/** Longest listing of tables printed; `details` keeps them all. */
const MAX_LISTED_TABLES = 500;

/** Longest error text handed back, after escaping. */
const MAX_ERROR_CHARS = 2000;

/**
 * JSON with every character that could break a line or flip the text direction escaped, which
 * `JSON.stringify` leaves alone: C1 controls, `Cf` format characters, U+2028 and U+2029.
 *
 * @param value - Any JSON value.
 * @returns {string} One line of JSON.
 */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value).replaceAll(/[\u0080-\u009F\p{Cf}\u2028\u2029]/gu, (char) => {
    const point = char.codePointAt(0) ?? 0;
    /* Past U+FFFF, JSON wants the two UTF-16 halves, each as its own escape. */
    const units =
      point > 0xff_ff
        ? [0xd8_00 + ((point - 0x1_00_00) >> 10), 0xdc_00 + ((point - 0x1_00_00) & 0x3_ff)]
        : [point];
    return units.map((unit) => `\\u${unit.toString(16).padStart(4, "0")}`).join("");
  });
}

/**
 * Text that came from a database or a caller, as one safe line.
 *
 * @param text - Raw text.
 * @returns {string} The text with control and format characters replaced.
 */
function shown(text: string): string {
  return sanitizeLine(text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text);
}

/**
 * A row limit, reading `0`, which OMP sends for an unset number, as no limit given.
 *
 * @param limit - The argument.
 * @returns {number | undefined} The limit, or nothing.
 */
function limitOf(limit: number | undefined): number | undefined {
  return limit === 0 ? undefined : limit;
}

/**
 * Opens the database, runs the work and turns a failure into one clean line for the model.
 *
 * @param reference - The `database` argument.
 * @param work - What to do with the provider.
 * @returns {Promise<{ provider: Provider; value: T }>} The provider and the result.
 */
async function withDatabase<T>(
  reference: string,
  work: (provider: Provider) => Promise<T>,
): Promise<{ provider: Provider; value: T }> {
  try {
    const provider = await open(reference);
    return { provider, value: await work(provider) };
  } catch (error) {
    if (error instanceof DatabasesError) {
      throw new DatabasesError(`${shown(error.message)} [${error.code}]`, {
        code: error.code,
        ...(error.provider ? { provider: error.provider } : {}),
        ...(error.engineCode ? { engineCode: error.engineCode } : {}),
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Where an answer came from, for its first line.
 *
 * @param provider - The provider that answered.
 * @returns {string} Label and engine.
 */
function source(provider: Provider): string {
  return `${shown(provider.target.label)} (${provider.key})`;
}

/**
 * The name of a table as the listing prints it.
 *
 * @param table - A table summary.
 * @returns {string} `schema.table` or `table`.
 */
function qualified(table: Readonly<TableSummary>): string {
  return table.schema === undefined ? table.name : `${table.schema}.${table.name}`;
}

export interface ProvidersDetails {
  readonly providers: readonly ProviderMeta[];
  readonly connections: readonly NamedConnection[];
  readonly writes: boolean;
}

/**
 * Whether `databases_execute` may write on this server.
 *
 * @returns {boolean} True with `DATABASES_WRITE=1`.
 */
export function writesAllowed(): boolean {
  return process.env["DATABASES_WRITE"] === "1";
}

/**
 * Engines, configured connections and the write switch.
 *
 * @returns {ToolResult<ProvidersDetails>} The listing.
 */
export function listProviders(): ToolResult<ProvidersDetails> {
  const providers = listRegistered();
  const connections = listConnections();
  const writes = writesAllowed();
  const lines = [`${providers.length} engines:`];
  for (const meta of providers) {
    lines.push(
      `${meta.key}  ${shown(meta.title)}`,
      `  reference: ${shown(meta.reference)}`,
      `  read-only: ${shown(meta.readOnly)}`,
    );
    if (meta.credentials) lines.push(`  credentials: ${shown(meta.credentials)}`);
  }
  lines.push(
    connections.length === 0
      ? "No connections configured. Set DATABASES_<NAME>_URL to name one, then pass the name as database."
      : `${connections.length} connections, pass the name as database:`,
  );
  for (const connection of connections) {
    lines.push(`${shown(connection.name)}  ${connection.provider}  ${shown(connection.label)}`);
  }
  lines.push(
    writes
      ? "Writes: on, databases_execute runs (DATABASES_WRITE=1)."
      : "Writes: off, databases_execute refuses. Set DATABASES_WRITE=1 for the server to allow it.",
  );
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { providers, connections, writes },
  };
}

export interface SchemaDetails {
  readonly database: string;
  readonly provider: string;
  readonly tables?: readonly TableSummary[];
  readonly table?: TableDetail;
}

/**
 * One column as a line of facts.
 *
 * @param column - The column.
 * @returns {string} Name, type, nullability, default and key position.
 */
function columnLine(column: Readonly<ColumnInfo>): string {
  const facts = [
    shown(column.name),
    shown(column.type),
    column.nullable ? "null" : "not null",
    ...(column.default === undefined ? [] : [`default ${shown(column.default)}`]),
    ...(column.primaryKey === undefined ? [] : [`primary key ${column.primaryKey}`]),
  ];
  return `  ${facts.join("  ")}`;
}

/**
 * One table's description as lines.
 *
 * @param table - The table.
 * @returns {string[]} Columns, indexes and foreign keys.
 */
function describeLines(table: Readonly<TableDetail>): string[] {
  const lines = [`${shown(qualified(table))} (${table.kind}), ${table.columns.length} columns:`];
  for (const column of table.columns) lines.push(columnLine(column));
  lines.push(table.indexes.length === 0 ? "No indexes." : `${table.indexes.length} indexes:`);
  for (const index of table.indexes) {
    lines.push(
      `  ${shown(index.name)}${index.unique ? " unique" : ""} (${index.columns.map(shown).join(", ")})`,
    );
  }
  lines.push(
    table.foreignKeys.length === 0
      ? "No foreign keys."
      : `${table.foreignKeys.length} foreign keys:`,
  );
  for (const key of table.foreignKeys) {
    lines.push(
      `  (${key.columns.map(shown).join(", ")}) -> ${shown(key.table)} (${key.references.map(shown).join(", ")})`,
    );
  }
  return lines;
}

/**
 * Lists the tables, or describes one.
 *
 * @param input - Database and optional table.
 * @param input.table - Table to describe.
 * @param signal - Cancellation.
 * @returns {Promise<ToolResult<SchemaDetails>>} The schema.
 */
export async function getSchema(
  input: DatabaseInput & { readonly table?: string },
  signal?: AbortSignal,
): Promise<ToolResult<SchemaDetails>> {
  const options = signal ? { signal } : {};
  if (input.table !== undefined && input.table.trim() !== "") {
    const name = input.table;
    const { provider, value } = await withDatabase(input.database, (db) => db.table(name, options));
    return {
      content: [
        { type: "text", text: [`In ${source(provider)}:`, ...describeLines(value)].join("\n") },
      ],
      details: { database: provider.target.label, provider: provider.key, table: value },
    };
  }
  const { provider, value } = await withDatabase(input.database, (db) => db.tables(options));
  const lines = [`${source(provider)}: ${value.length} tables and views`];
  for (const table of value.slice(0, MAX_LISTED_TABLES)) {
    lines.push(`${shown(qualified(table))}  ${table.kind}`);
  }
  if (value.length > MAX_LISTED_TABLES) {
    lines.push(`… ${value.length - MAX_LISTED_TABLES} more left out; describe one by name.`);
  }
  if (value.length > 0) lines.push("Pass one as table for its columns, indexes and keys.");
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { database: provider.target.label, provider: provider.key, tables: value },
  };
}

export interface QueryDetails extends QueryResult {
  readonly database: string;
  readonly provider: string;
}

/**
 * Rows as text: a header, the column names and types, one JSON array per row, then notes.
 *
 * @param provider - Who answered.
 * @param result - The rows.
 * @param limit - The limit asked for, for the note on more rows.
 * @returns {string} The answer.
 */
function rowsText(provider: Provider, result: QueryResult, limit: number): string {
  const count = result.rows.length;
  const lines = [
    `${source(provider)}: ${count} ${count === 1 ? "row" : "rows"}${result.more ? `, more not read (limit ${limit})` : ""}`,
  ];
  if (result.columns.length === 0) {
    lines.push("The statement returns no columns.");
    return lines.join("\n");
  }
  lines.push(`columns: ${jsonLine(result.columns.map((column: Readonly<Column>) => column.name))}`);
  if (result.columns.some((column) => column.type !== undefined)) {
    lines.push(`types: ${jsonLine(result.columns.map((column) => column.type ?? null))}`);
  }
  for (const row of result.rows) lines.push(jsonLine(row));
  if (result.more) {
    lines.push(
      limit < MAX_ROWS
        ? `More rows exist. Narrow the query, aggregate it, or raise limit (up to ${MAX_ROWS}).`
        : "More rows exist. Narrow the query or aggregate it.",
    );
  }
  if (result.cut) {
    lines.push(
      "Some values were shortened: long text ends in […+N chars], a blob shows its first bytes, or rows were dropped to keep the answer small.",
    );
  }
  return lines.join("\n");
}

/**
 * Runs one read-only statement.
 *
 * @param input - Database, statement, parameters and limit.
 * @param input.limit - Rows to return.
 * @param signal - Cancellation.
 * @returns {Promise<ToolResult<QueryDetails>>} The rows.
 */
export async function runQuery(
  input: StatementInput & { readonly limit?: number },
  signal?: AbortSignal,
): Promise<ToolResult<QueryDetails>> {
  const limit = limitOf(input.limit);
  const { provider, value } = await withDatabase(input.database, (db) =>
    db.query(input.sql, {
      ...(input.params ? { params: input.params } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(signal ? { signal } : {}),
    }),
  );
  return {
    content: [{ type: "text", text: rowsText(provider, value, limit ?? 50) }],
    details: { database: provider.target.label, provider: provider.key, ...value },
  };
}

/**
 * Reads the first rows of a table.
 *
 * @param input - Database, table and limit.
 * @param input.table - The table.
 * @param input.limit - Rows to read.
 * @param signal - Cancellation.
 * @returns {Promise<ToolResult<QueryDetails>>} The rows.
 */
export async function sampleTable(
  input: DatabaseInput & { readonly table: string; readonly limit?: number },
  signal?: AbortSignal,
): Promise<ToolResult<QueryDetails>> {
  const limit = limitOf(input.limit);
  const { provider, value } = await withDatabase(input.database, (db) =>
    db.sample(input.table, {
      ...(limit === undefined ? {} : { limit }),
      ...(signal ? { signal } : {}),
    }),
  );
  return {
    content: [{ type: "text", text: rowsText(provider, value, limit ?? 10) }],
    details: { database: provider.target.label, provider: provider.key, ...value },
  };
}

export interface PlanDetails extends PlanResult {
  readonly database: string;
  readonly provider: string;
}

/**
 * The plan of one statement.
 *
 * @param input - Database, statement and parameters.
 * @param signal - Cancellation.
 * @returns {Promise<ToolResult<PlanDetails>>} The plan.
 */
export async function explainQuery(
  input: StatementInput,
  signal?: AbortSignal,
): Promise<ToolResult<PlanDetails>> {
  const { provider, value } = await withDatabase(input.database, (db) =>
    db.explain(input.sql, {
      ...(input.params ? { params: input.params } : {}),
      ...(signal ? { signal } : {}),
    }),
  );
  return {
    content: [
      {
        type: "text",
        text: [`Plan in ${source(provider)}:`, ...value.lines.map((line) => shown(line))].join(
          "\n",
        ),
      },
    ],
    details: { database: provider.target.label, provider: provider.key, ...value },
  };
}

export interface ExecuteDetails extends ExecuteResult {
  readonly database: string;
  readonly provider: string;
}

/**
 * Runs one statement that may write, when the server allows writes.
 *
 * @param input - Database, statement and parameters.
 * @param signal - Cancellation.
 * @returns {Promise<ToolResult<ExecuteDetails>>} How many rows changed.
 */
export async function executeStatement(
  input: StatementInput,
  signal?: AbortSignal,
): Promise<ToolResult<ExecuteDetails>> {
  if (!writesAllowed()) {
    throw new DatabasesError(
      "Writes are off on this server, so nothing ran. Ask the user to start it with DATABASES_WRITE=1 if the change is wanted. [refused]",
      { code: "refused" },
    );
  }
  const { provider, value } = await withDatabase(input.database, (db) =>
    db.execute(input.sql, {
      ...(input.params ? { params: input.params } : {}),
      ...(signal ? { signal } : {}),
    }),
  );
  const lines = [
    `${source(provider)}: ${value.changes} ${value.changes === 1 ? "row" : "rows"} changed`,
  ];
  if (value.lastInsertId !== undefined && value.lastInsertId !== "0") {
    lines.push(`Last insert id: ${shown(value.lastInsertId)}`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { database: provider.target.label, provider: provider.key, ...value },
  };
}
