/**
 * Cloudflare D1 over the REST API.
 *
 * D1 runs whatever SQL it is sent, writes included, and splits a string on `;` into several
 * statements. So before a read leaves this process it is prepared, in a local child, against an
 * empty copy of the database schema under SQLite's authorizer: a write or a second statement fails
 * there and is never sent. The copy also gives the declared column types D1's answer lacks.
 */

import type { CloudflareCredential } from "@agntn/credentials/cloudflare";
import { DatabasesError, type DatabasesErrorCode } from "../core/errors.ts";
import { STATEMENT_TIMEOUT_MS } from "../core/limits.ts";
import {
  checkStatement,
  Provider,
  quoteIdentifier,
  rowLimit,
  splitName,
} from "../core/provider.ts";
import {
  alreadyApplied,
  checkMigration,
  createMigrationTable,
  recordMigrationLiteral,
  type AppliedMigration,
  type MigrateOptions,
  type MigrationScript,
} from "../core/migration-table.ts";
import {
  appliedFrom,
  describeTable,
  listTables,
  planTree,
  type ReadRows,
} from "../core/sqlite-catalog.ts";
import { runChild } from "../core/sqlite-protocol.ts";
import type {
  Cell,
  Column,
  ExecuteOptions,
  ExecuteResult,
  ExplainOptions,
  Param,
  PlanResult,
  QueryOptions,
  QueryResult,
  SchemaOptions,
  TableDetail,
  TableSummary,
} from "../core/types.ts";
import { fitRows, toCell, type CellBudget } from "../core/values.ts";

const API = "https://api.cloudflare.com/client/v4";

/** D1 keeps its own state in `_cf_` tables, which it never lets a query touch. */
const HIDDEN = /^_cf_/u;

const SCHEMA = `SELECT sql FROM sqlite_schema
WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END`;

/** How long a schema copy is reused before it is read again. */
const SCHEMA_TTL_MS = 60_000;

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

interface Envelope<T> {
  readonly success?: boolean;
  readonly result?: T;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
}

interface RawResult {
  readonly results?: { readonly columns?: readonly string[]; readonly rows?: readonly unknown[][] };
  readonly meta?: { readonly changes?: number; readonly last_row_id?: number };
}

interface Session {
  readonly credential: CloudflareCredential;
  readonly database: string;
}

/**
 * Finds a Cloudflare token and account through `@agntn/credentials`.
 *
 * @param account - The account a `d1://` reference names.
 * @param refresh - Ask cf again although its cached token has not expired.
 * @param signal - Cancellation.
 * @returns {Promise<CloudflareCredential>} Token, account and where they came from.
 * @throws {DatabasesError} `auth` without a token, `config` without one account.
 */
async function lookupCredential(
  account: string | undefined,
  refresh: boolean,
  signal?: AbortSignal,
): Promise<CloudflareCredential> {
  const [{ CredentialsError }, { resolve }] = await Promise.all([
    import("@agntn/credentials"),
    import("@agntn/credentials/cloudflare"),
  ]);
  try {
    return await resolve({
      refresh,
      ...(account ? { accountId: account } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (!(error instanceof CredentialsError)) throw error;
    throw new DatabasesError(error.message, {
      code: error.code === "account" ? "config" : "auth",
      provider: "d1",
      cause: error,
    });
  }
}

/**
 * Sends one request to the account API.
 *
 * @param credential - Token and account.
 * @param path - Path under `/accounts/<id>`.
 * @param body - JSON body for a POST, none for a GET.
 * @param signal - Cancellation.
 * @returns {Promise<Response>} The response, whatever its status.
 * @throws {DatabasesError} `timeout` past the deadline, `connection` when nothing answered.
 */
async function send(
  credential: CloudflareCredential,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const deadline = AbortSignal.timeout(STATEMENT_TIMEOUT_MS);
  const json = body === undefined ? {} : { body: JSON.stringify(body) };
  try {
    return await fetch(`${API}/accounts/${encodeURIComponent(credential.accountId)}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      ...json,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw deadline.aborted
      ? new DatabasesError(`D1 did not answer within ${STATEMENT_TIMEOUT_MS / 1000} s`, {
          code: "timeout",
          provider: "d1",
          cause: error,
        })
      : new DatabasesError(`Can't reach the Cloudflare API: ${String(error)}`, {
          code: "connection",
          provider: "d1",
          cause: error,
        });
  }
}

/**
 * The result of a Cloudflare envelope, or its errors as one failure.
 *
 * @param response - What the API answered.
 * @returns {Promise<T>} The result.
 * @throws {DatabasesError} `auth` on 401 and 403, `config` on 404, `query` otherwise.
 */
async function readEnvelope<T>(response: Response): Promise<T> {
  const envelope = ((await response.json().catch(() => undefined)) ?? {}) as Envelope<T>;
  if (response.ok && envelope.success !== false && envelope.result !== undefined) {
    return envelope.result;
  }
  throw envelopeError(envelope, response.status);
}

/**
 * A failed envelope as one error.
 *
 * @param envelope - Parsed body, empty when it didn't parse.
 * @param status - HTTP status.
 * @returns {DatabasesError} The error.
 */
function envelopeError(envelope: Readonly<Envelope<unknown>>, status: number): DatabasesError {
  return new DatabasesError(reasonOf(envelope) || `D1 answered HTTP ${status}`, {
    code: STATUS_CODES[status] ?? "query",
    provider: "d1",
    engineCode: String(envelope.errors?.[0]?.code ?? status),
  });
}

/**
 * The errors of an envelope as one line, each cut and cleaned: it is the server's text.
 *
 * @param envelope - Parsed body, empty when it didn't parse.
 * @returns {string} The reasons, or an empty string.
 */
function reasonOf(envelope: Readonly<Envelope<unknown>>): string {
  return (envelope.errors ?? [])
    .slice(0, 5)
    .map((error) => (error.message ?? "").slice(0, 500).replaceAll(/[\p{Cc}\p{Cf}]/gu, " "))
    .filter(Boolean)
    .join("; ");
}

/** HTTP statuses that say more than "the statement failed". */
const STATUS_CODES: Readonly<Record<number, DatabasesErrorCode>> = {
  401: "auth",
  403: "auth",
  404: "config",
};

/** Schema copies by account and database, shared by every D1 provider in the process. */
const schemas = new Map<string, { readonly at: number; readonly statements: Promise<string[]> }>();

export class D1 extends Provider {
  static readonly key = "d1";
  #session: Promise<Session> | undefined;

  get key(): string {
    return D1.key;
  }

  /**
   * The credential and the database id, a name looked up once.
   *
   * @param signal - Cancellation.
   * @returns {Promise<Session>} Where requests go.
   */
  #open(signal?: AbortSignal): Promise<Session> {
    this.#session ??= this.#resolve(signal).catch((error: unknown) => {
      this.#session = undefined;
      throw error;
    });
    return this.#session;
  }

  /**
   * Finds the credential, then the database id behind a name.
   *
   * @param signal - Cancellation.
   * @returns {Promise<Session>} Where requests go.
   */
  async #resolve(signal?: AbortSignal): Promise<Session> {
    const credential = await lookupCredential(this.target.account, false, signal);
    const wanted = this.target.target;
    if (UUID.test(wanted)) return { credential, database: wanted.toLowerCase() };
    const found = await this.#request<readonly { uuid?: string; name?: string }[]>(
      credential,
      `/d1/database?name=${encodeURIComponent(wanted)}&per_page=100`,
      undefined,
      signal,
    );
    const match = found.find((database) => database.name === wanted);
    if (!match?.uuid) {
      throw new DatabasesError(`No D1 database named ${JSON.stringify(wanted)} in this account`, {
        code: "config",
        provider: D1.key,
      });
    }
    return { credential, database: match.uuid };
  }

  /**
   * One request to the account API.
   *
   * @param credential - Token and account.
   * @param path - Path under `/accounts/<id>`.
   * @param body - JSON body for a POST, none for a GET.
   * @param signal - Cancellation.
   * @returns {Promise<T>} The envelope's result.
   */
  async #request<T>(
    credential: CloudflareCredential,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await send(credential, path, body, signal);
    if (response.status !== 401 || credential.source !== "cli") return readEnvelope<T>(response);
    /* A cf OAuth token can lapse before its recorded expiry; a 401 applied nothing, so resend. */
    const fresh = await lookupCredential(this.target.account, true, signal);
    this.#session = this.#session?.then((session) => ({ ...session, credential: fresh }));
    return readEnvelope<T>(await send(fresh, path, body, signal));
  }

  /**
   * Runs one statement on D1 as arrays of values.
   *
   * @param sql - The statement, checked by the caller.
   * @param params - Parameters.
   * @param signal - Cancellation.
   * @returns {Promise<RawResult>} Columns, rows and meta.
   */
  async #raw(sql: string, params: readonly Param[], signal?: AbortSignal): Promise<RawResult> {
    const session = await this.#open(signal);
    const results = await this.#request<readonly RawResult[]>(
      session.credential,
      `/d1/database/${session.database}/raw`,
      { sql, params },
      signal,
    );
    return results[0] ?? {};
  }

  /**
   * `CREATE` statements of the remote schema, cached for a minute.
   *
   * @param signal - Cancellation.
   * @returns {Promise<string[]>} The statements, tables first.
   */
  async #schema(signal?: AbortSignal): Promise<string[]> {
    const session = await this.#open(signal);
    const key = `${session.credential.accountId}/${session.database}`;
    const cached = schemas.get(key);
    if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.statements;
    const statements = this.#raw(SCHEMA, [], signal).then((result) =>
      (result.results?.rows ?? []).map((row) => String(row[0])),
    );
    schemas.set(key, { at: Date.now(), statements });
    statements.catch(() => schemas.delete(key));
    return statements;
  }

  /**
   * Prepares a statement against the schema copy; throws for anything that isn't a read.
   *
   * @param sql - The statement.
   * @param write - Check only that it is one statement, for execute.
   * @param signal - Cancellation.
   * @returns {Promise<Column[]>} Its columns with declared types.
   */
  async #check(sql: string, write: boolean, signal?: AbortSignal): Promise<readonly Column[]> {
    const schema = await this.#schema(signal);
    try {
      const [result] = await runChild({ kind: "check", schema, sql, write }, { signal });
      return result && "columns" in result ? result.columns : [];
    } catch (error) {
      if (error instanceof DatabasesError && error.code === "query" && !write) {
        throw new DatabasesError(
          `Refused before sending: the statement doesn't prepare against this database's schema (${error.message})`,
          { code: "refused", provider: D1.key, cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * A reader for catalog statements, which this module writes and so sends unchecked.
   *
   * @param signal - Cancellation.
   * @returns {ReadRows} The reader.
   */
  #reader(signal?: AbortSignal): ReadRows {
    return async (sql, params) => {
      const result = await this.#raw(sql, params, signal);
      const budget: CellBudget = { cut: false };
      return (result.results?.rows ?? []).map((row) => row.map((value) => toCell(value, budget)));
    };
  }

  tables(options: SchemaOptions = {}): Promise<TableSummary[]> {
    return listTables(this.#reader(options.signal), HIDDEN);
  }

  table(name: string, options: SchemaOptions = {}): Promise<TableDetail> {
    return describeTable(this.#reader(options.signal), name, HIDDEN);
  }

  async query(sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    const params = checkStatement(sql, options.params);
    const limit = rowLimit(options.limit);
    const declared = await this.#check(sql, false, options.signal);
    const result = await this.#raw(sql, params, options.signal);
    const names = result.results?.columns ?? declared.map((column) => column.name);
    const columns: Column[] = names.map((name, index) => {
      const type = declared[index]?.type;
      return type ? { name, type } : { name };
    });
    const budget: CellBudget = { cut: false };
    const all = result.results?.rows ?? [];
    const cells: Cell[][] = all
      .slice(0, limit)
      .map((row) => row.map((value) => toCell(value, budget)));
    return { columns, rows: fitRows(cells, budget), more: all.length > limit, cut: budget.cut };
  }

  async explain(sql: string, options: ExplainOptions = {}): Promise<PlanResult> {
    const params = checkStatement(sql, options.params);
    const text = `EXPLAIN QUERY PLAN ${sql}`;
    await this.#check(text, false, options.signal);
    const result = await this.#raw(text, params, options.signal);
    return planTree((result.results?.rows ?? []) as readonly (readonly Cell[])[]);
  }

  async execute(sql: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const params = checkStatement(sql, options.params);
    await this.#check(sql, true, options.signal);
    const result = await this.#raw(sql, params, options.signal);
    schemas.clear();
    return {
      changes: result.meta?.changes ?? 0,
      ...(result.meta?.last_row_id ? { lastInsertId: String(result.meta.last_row_id) } : {}),
    };
  }

  override async appliedMigrations(options: MigrateOptions = {}): Promise<AppliedMigration[]> {
    return appliedFrom(this.#reader(options.signal));
  }

  /**
   * D1 has no BEGIN but rolls back a failed `/query` batch, as wrangler relies on. The record goes
   * first as literals, so an unclosed comment in the file can't swallow it.
   *
   * @param script - The file's SQL with its name, checksum and time.
   * @param options - Cancellation.
   * @returns {Promise<{ applied: boolean }>} `false` when the table already had that name.
   */
  override async migrate(
    script: MigrationScript,
    options: MigrateOptions = {},
  ): Promise<{ applied: boolean }> {
    checkMigration(script);
    const done = await this.appliedMigrations(options);
    const recorded = done.find((migration) => migration.name === script.name)?.checksum;
    if (alreadyApplied(script, recorded)) return { applied: false };
    const session = await this.#open(options.signal);
    const sql = [createMigrationTable(), recordMigrationLiteral(script), script.sql].join("\n;\n");
    try {
      await this.#request<unknown>(
        session.credential,
        `/d1/database/${session.database}/query`,
        { sql },
        options.signal,
      );
    } finally {
      schemas.clear();
    }
    return { applied: true };
  }

  protected quoteTable(name: string): string {
    return splitName(name).map(quoteIdentifier).join(".");
  }
}
