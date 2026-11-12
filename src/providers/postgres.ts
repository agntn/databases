/**
 * Postgres through postgres.js, one short connection per call.
 *
 * Reads run in a `READ ONLY` transaction opened with `default_transaction_read_only`, under a
 * transaction-local `statement_timeout`. Statements go over the extended protocol, which refuses
 * a second command in one string, so `SELECT 1; DELETE ...` never reaches the planner.
 */

import postgres from "postgres";
import { DatabasesError, type DatabasesErrorCode } from "../core/errors.ts";
import { CONNECT_TIMEOUT_MS, STATEMENT_TIMEOUT_MS } from "../core/limits.ts";
import {
  checkStatement,
  nameParts,
  Provider,
  quoteIdentifier,
  rowLimit,
  splitName,
} from "../core/provider.ts";
import { scrub, secretsOf } from "../core/reference.ts";
import type {
  Cell,
  Column,
  ColumnInfo,
  ExecuteOptions,
  ExecuteResult,
  ExplainOptions,
  ForeignKeyInfo,
  IndexInfo,
  Param,
  PlanResult,
  QueryOptions,
  QueryResult,
  RelationKind,
  SchemaOptions,
  TableDetail,
  TableSummary,
} from "../core/types.ts";
import { fitRows, toCell, type CellBudget } from "../core/values.ts";

type Sql = postgres.Sql;
/** What the work inside a transaction may do with it: send statements. */
type Transaction = Readonly<Pick<postgres.TransactionSql, "unsafe">>;
type Row = readonly unknown[];

const KINDS: Record<string, RelationKind> = {
  r: "table",
  p: "table",
  v: "view",
  m: "materialized view",
  f: "foreign table",
};

const TABLES = `SELECT n.nspname, c.relname, c.relkind::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
  AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 1, 2 LIMIT 10000`;

const FIND = `SELECT c.oid::text, n.nspname, c.relname, c.relkind::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname::text IN ($1::text, lower($1::text))
  AND ($2::text IS NULL OR n.nspname::text IN ($2::text, lower($2::text)))
ORDER BY c.relname::text = $1::text DESC, n.nspname = ANY (current_schemas(false)) DESC, n.nspname
LIMIT 1`;

const COLUMNS = `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
  pg_get_expr(d.adbin, d.adrelid), array_position(pk.conkey, a.attnum)
FROM pg_attribute a
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_constraint pk ON pk.conrelid = a.attrelid AND pk.contype = 'p'
WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`;

const INDEXES = `SELECT i.relname, x.indisunique, pg_get_indexdef(x.indexrelid),
  ARRAY(SELECT pg_get_indexdef(x.indexrelid, k, true) FROM generate_series(1, x.indnkeyatts) AS k)
FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
WHERE x.indrelid = $1::oid ORDER BY i.relname`;

const FOREIGN_KEYS = `SELECT
  ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY AS u(num, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.num ORDER BY u.ord),
  c.confrelid::regclass::text,
  ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY AS u(num, ord)
    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.num ORDER BY u.ord)
FROM pg_constraint c WHERE c.conrelid = $1::oid AND c.contype = 'f' ORDER BY c.conname`;

const TYPE_NAMES = `SELECT oid::int, format_type(oid, NULL) FROM pg_type WHERE oid = ANY ($1::oid[])`;

/**
 * Every statement goes over the extended protocol. postgres.js picks the simple one for a string
 * without parameters, and the simple protocol runs every command in the string, a `COMMIT` that
 * ends the read-only transaction included.
 */
const EXTENDED = { simple: false } as const;

/** SQLSTATE classes and codes that say more than "the query failed". */
const SQLSTATE: Record<string, DatabasesErrorCode> = {
  "25006": "refused",
  "57014": "timeout",
  "28000": "auth",
  "28P01": "auth",
  "3D000": "config",
  "08001": "connection",
  "08006": "connection",
};

/** Node and postgres.js codes for a database that could not be reached. */
const UNREACHABLE = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

/** What Postgres says when the extended protocol gets more than one command. */
const MULTIPLE = /prepared statement|przygotowane/iu;

/** A SQLSTATE: five digits or capitals. */
const SQLSTATE_FORM = /^[\dA-Z]{5}$/u;

const ONE_STATEMENT =
  "Refused: send one statement per call. Everything after the first `;` would have run too";

/**
 * Which kind of failure a driver error is.
 *
 * @param engineCode - SQLSTATE, or a Node or postgres.js code.
 * @param raw - The driver's message, for the one SQLSTATE that means two things.
 * @returns {DatabasesErrorCode} The kind.
 */
function errorCode(engineCode: string, raw: string): DatabasesErrorCode {
  if (engineCode === "42601" && MULTIPLE.test(raw)) return "refused";
  if (UNREACHABLE.has(engineCode)) return "connection";
  if (!SQLSTATE_FORM.test(engineCode)) return "query";
  return SQLSTATE[engineCode] ?? (engineCode.startsWith("08") ? "connection" : "query");
}

/**
 * The message for a failure of that kind.
 *
 * @param code - The kind.
 * @param engineCode - SQLSTATE or driver code.
 * @param message - The driver's message, secrets removed.
 * @param label - The database, password hidden.
 * @returns {string} The message.
 */
function errorMessage(
  code: DatabasesErrorCode,
  engineCode: string,
  message: string,
  label: string,
): string {
  if (code === "connection") return `Can't reach ${label}: ${message}`;
  if (code !== "refused") return message;
  return engineCode === "25006"
    ? `Refused: the statement writes, and reads run in a read-only transaction. Use execute for a write. Postgres said: ${message}`
    : ONE_STATEMENT;
}

/**
 * Bind parameters as postgres.js takes them.
 *
 * @param params - Checked parameters.
 * @returns {postgres.ParameterOrJSON<never>[]} The same values.
 */
function bind(params: readonly Param[]): postgres.ParameterOrJSON<never>[] {
  return [...params];
}

export class Postgres extends Provider {
  static readonly key = "postgres";

  get key(): string {
    return Postgres.key;
  }

  /**
   * A one-connection client for this call.
   *
   * @param readOnly - Open the session read-only.
   * @returns {Sql} The client; nothing connects before the first statement.
   */
  #connect(readOnly: boolean): Sql {
    return postgres(this.target.target, {
      max: 1,
      prepare: false,
      connect_timeout: CONNECT_TIMEOUT_MS / 1000,
      idle_timeout: 1,
      onnotice: () => {
        /* Notices are not part of an answer. */
      },
      connection: {
        application_name: "agntn-databases",
        ...(readOnly ? { default_transaction_read_only: true } : {}),
      },
    });
  }

  /**
   * Runs work in one transaction on a fresh connection, then closes it.
   *
   * @param readOnly - Open a `READ ONLY` transaction.
   * @param work - What to run inside it.
   * @param signal - Ends the connection, which fails the pending statement.
   * @returns {Promise<T>} What `work` returned.
   */
  async #transaction<T>(
    readOnly: boolean,
    work: (tx: Transaction) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const sql = this.#connect(readOnly);
    const onAbort = (): void => void sql.end({ timeout: 0 });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const run = async (tx: Transaction): Promise<T> => {
        await tx.unsafe(
          "SELECT set_config('statement_timeout', $1, true)",
          [String(STATEMENT_TIMEOUT_MS)],
          EXTENDED,
        );
        return work(tx);
      };
      return (await (readOnly ? sql.begin("read only", run) : sql.begin(run))) as T;
    } catch (error) {
      signal?.throwIfAborted();
      throw this.#error(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await sql.end({ timeout: 1 }).catch(() => undefined);
    }
  }

  /**
   * Sorts a driver failure into the error family, without the password.
   *
   * @param error - What postgres.js threw.
   * @returns {DatabasesError} The error to throw.
   */
  #error(error: unknown): DatabasesError {
    if (error instanceof DatabasesError) return error;
    const raw = error instanceof Error ? error.message : String(error);
    const message = scrub(raw, secretsOf(this.target));
    const engineCode =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    const code = errorCode(engineCode, raw);
    return new DatabasesError(errorMessage(code, engineCode, message, this.target.label), {
      code,
      provider: Postgres.key,
      cause: error,
      ...(engineCode ? { engineCode } : {}),
    });
  }

  /**
   * Rows of a catalog statement, as arrays.
   *
   * @param tx - Open transaction.
   * @param text - Statement.
   * @param params - Parameters.
   * @returns {Promise<Row[]>} Every row.
   */
  async #rows(tx: Transaction, text: string, params: readonly Param[] = []): Promise<Row[]> {
    const result = await tx.unsafe(text, bind(params), EXTENDED).values();
    return [...result] as Row[];
  }

  async tables(options: SchemaOptions = {}): Promise<TableSummary[]> {
    const rows = await this.#transaction(true, (tx) => this.#rows(tx, TABLES), options.signal);
    return rows.map((row) => ({
      schema: String(row[0]),
      name: String(row[1]),
      kind: KINDS[String(row[2])] ?? "table",
    }));
  }

  async table(name: string, options: SchemaOptions = {}): Promise<TableDetail> {
    const parts = splitName(name);
    const [schema, table] = parts.length === 2 ? parts : [null, parts[0] ?? ""];
    return this.#transaction(
      true,
      async (tx) => {
        const found = (await this.#rows(tx, FIND, [table, schema]))[0];
        if (!found) {
          throw new DatabasesError(`No table or view named ${JSON.stringify(name)}`, {
            code: "query",
            provider: Postgres.key,
          });
        }
        const oid = String(found[0]);
        const columns = await this.#rows(tx, COLUMNS, [oid]);
        const indexes = await this.#rows(tx, INDEXES, [oid]);
        const foreignKeys = await this.#rows(tx, FOREIGN_KEYS, [oid]);
        return {
          schema: String(found[1]),
          name: String(found[2]),
          kind: KINDS[String(found[3])] ?? "table",
          columns: columns.map((row): ColumnInfo => ({
            name: String(row[0]),
            type: String(row[1]),
            nullable: row[2] === true,
            ...(typeof row[3] === "string" ? { default: row[3] } : {}),
            ...(row[4] === null ? {} : { primaryKey: Number(row[4]) }),
          })),
          indexes: indexes.map((row): IndexInfo => ({
            name: String(row[0]),
            unique: row[1] === true,
            definition: String(row[2]),
            columns: (row[3] as unknown[]).map(String),
          })),
          foreignKeys: foreignKeys.map((row): ForeignKeyInfo => ({
            columns: (row[0] as unknown[]).map(String),
            table: String(row[1]),
            references: (row[2] as unknown[]).map(String),
          })),
        };
      },
      options.signal,
    );
  }

  async query(sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    const params = checkStatement(sql, options.params);
    const limit = rowLimit(options.limit);
    return this.#transaction(
      true,
      async (tx) => {
        const described = await tx.unsafe(sql, bind(params), EXTENDED).describe();
        const fields = described.columns ?? [];
        const names = await this.#typeNames(
          tx,
          fields.map((field) => field.type),
        );
        const columns: Column[] = fields.map((field) => ({
          name: field.name,
          ...(names.has(field.type) ? { type: names.get(field.type) } : {}),
        }));
        if (fields.length === 0) {
          /* No result columns: a write, which the read-only transaction refuses, or a utility. */
          await tx.unsafe(sql, bind(params), EXTENDED);
          return { columns, rows: [], more: false, cut: false };
        }
        const budget: CellBudget = { cut: false };
        let batch: Row[] = [];
        for await (const rows of tx
          .unsafe(sql, bind(params), EXTENDED)
          .values()
          .cursor(limit + 1)) {
          batch = rows as unknown as Row[];
          break;
        }
        const cells = batch.slice(0, limit).map((row) => row.map((value) => toCell(value, budget)));
        const rows: Cell[][] = fitRows(cells, budget);
        return { columns, rows, more: batch.length > limit, cut: budget.cut };
      },
      options.signal,
    );
  }

  /**
   * Readable names of type OIDs.
   *
   * @param tx - Open transaction.
   * @param oids - Type OIDs from a description.
   * @returns {Promise<Map<number, string>>} Name by OID.
   */
  async #typeNames(tx: Transaction, oids: readonly number[]): Promise<Map<number, string>> {
    const unique = [...new Set(oids)];
    if (unique.length === 0) return new Map();
    const rows = await tx.unsafe(TYPE_NAMES, [unique.map(String)], EXTENDED).values();
    return new Map((rows as unknown as Row[]).map((row) => [Number(row[0]), String(row[1])]));
  }

  async explain(sql: string, options: ExplainOptions = {}): Promise<PlanResult> {
    const params = checkStatement(sql, options.params);
    const rows = await this.#transaction(
      true,
      (tx) => this.#rows(tx, `EXPLAIN ${sql}`, params),
      options.signal,
    );
    return { lines: rows.map((row) => String(row[0])) };
  }

  async execute(sql: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const params = checkStatement(sql, options.params);
    return this.#transaction(
      false,
      async (tx) => {
        const result = await tx.unsafe(sql, bind(params), EXTENDED);
        return { changes: result.count };
      },
      options.signal,
    );
  }

  /**
   * Quotes a name the way Postgres reads it: unquoted parts fold to lower case.
   *
   * @param name - `table` or `schema.table`.
   * @returns {string} The quoted name.
   */
  protected quoteTable(name: string): string {
    return nameParts(name)
      .map((part) => quoteIdentifier(part.quoted ? part.text : part.text.toLowerCase()))
      .join(".");
  }
}
