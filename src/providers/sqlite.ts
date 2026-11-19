/** A local SQLite file, read through `node:sqlite` in a child process. */

import {
  checkStatement,
  Provider,
  quoteIdentifier,
  rowLimit,
  splitName,
} from "../core/provider.ts";
import {
  checkMigration,
  MIGRATION_TIMEOUT_MS,
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
import { runChild, type ChildResult, type ChildStep } from "../core/sqlite-protocol.ts";
import type {
  ExecuteOptions,
  ExecuteResult,
  ExplainOptions,
  PlanResult,
  QueryOptions,
  QueryResult,
  SchemaOptions,
  TableDetail,
  TableSummary,
} from "../core/types.ts";

/** Rows a catalog statement may return; far above any real schema. */
const CATALOG_ROWS = 100_000;

/**
 * The rows of a result, or a failure for a run result where rows were asked for.
 *
 * @param result - One child result.
 * @returns {QueryResult} The rows.
 */
function rowsOf(result: ChildResult | undefined): QueryResult {
  if (!result || !("rows" in result)) return { columns: [], rows: [], more: false, cut: false };
  return result;
}

export class Sqlite extends Provider {
  static readonly key = "sqlite";

  get key(): string {
    return Sqlite.key;
  }

  /**
   * Runs read steps against the file.
   *
   * @param steps - Statements to read.
   * @param signal - Cancellation.
   * @returns {Promise<ChildResult[]>} One result per step.
   */
  #read(steps: readonly ChildStep[], signal?: AbortSignal): Promise<ChildResult[]> {
    return runChild({ kind: "file", path: this.target.target, write: false, steps }, { signal });
  }

  /**
   * One read statement's rows, for the catalog.
   *
   * @param signal - Cancellation.
   * @returns {ReadRows} The reader.
   */
  #reader(signal?: AbortSignal): ReadRows {
    return async (sql, params) =>
      rowsOf((await this.#read([{ sql, params, limit: CATALOG_ROWS }], signal))[0]).rows;
  }

  tables(options: SchemaOptions = {}): Promise<TableSummary[]> {
    return listTables(this.#reader(options.signal));
  }

  table(name: string, options: SchemaOptions = {}): Promise<TableDetail> {
    return describeTable(this.#reader(options.signal), name);
  }

  async query(sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    const params = checkStatement(sql, options.params);
    const limit = rowLimit(options.limit);
    return rowsOf((await this.#read([{ sql, params, limit }], options.signal))[0]);
  }

  async explain(sql: string, options: ExplainOptions = {}): Promise<PlanResult> {
    const params = checkStatement(sql, options.params);
    const [result] = await this.#read(
      [{ sql: `EXPLAIN QUERY PLAN ${sql}`, params, limit: CATALOG_ROWS }],
      options.signal,
    );
    return planTree(rowsOf(result).rows);
  }

  async execute(sql: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const params = checkStatement(sql, options.params);
    const [result] = await runChild(
      { kind: "file", path: this.target.target, write: true, steps: [{ sql, params, run: true }] },
      { signal: options.signal },
    );
    return result && "changes" in result ? result : { changes: 0 };
  }

  override async appliedMigrations(options: MigrateOptions = {}): Promise<AppliedMigration[]> {
    return appliedFrom(this.#reader(options.signal));
  }

  override async migrate(
    script: MigrationScript,
    options: MigrateOptions = {},
  ): Promise<{ applied: boolean }> {
    checkMigration(script);
    const [result] = await runChild(
      { kind: "migrate", path: this.target.target, script },
      { signal: options.signal, timeoutMs: MIGRATION_TIMEOUT_MS },
    );
    return { applied: result !== undefined && "applied" in result && result.applied };
  }

  protected quoteTable(name: string): string {
    return splitName(name).map(quoteIdentifier).join(".");
  }
}
