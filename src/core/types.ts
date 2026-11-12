/** Shapes shared by every provider, the tools and the public API. */

/** A bind parameter. Positional: `?` in SQLite and D1, `$1` in Postgres. */
export type Param = string | number | boolean | null;

/** Binary data as hex, cut to a short prefix; `bytes` is always the full size. */
export interface BlobCell {
  readonly $blob: string;
  readonly bytes: number;
  readonly cut?: true;
}

/** A value as the result carries it: JSON safe, with blobs and long text shortened. */
export type Cell =
  | string
  | number
  | boolean
  | null
  | BlobCell
  | readonly Cell[]
  | { readonly [key: string]: Cell };

export interface Column {
  readonly name: string;
  /** Declared or engine type, such as `integer` or `timestamp with time zone`, when known. */
  readonly type?: string;
}

export interface QueryOptions {
  readonly params?: readonly Param[];
  /** Most rows to return, 1 to `MAX_ROWS`. Default `DEFAULT_ROWS`. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface QueryResult {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly Cell[])[];
  /** The statement had more rows than the limit; only the first ones were read. */
  readonly more: boolean;
  /** A cell was shortened, or rows were left out to keep the answer small. */
  readonly cut: boolean;
}

export interface ExplainOptions {
  readonly params?: readonly Param[];
  readonly signal?: AbortSignal;
}

export interface PlanResult {
  /** The plan as the engine prints it, one step per line, nesting as indentation. */
  readonly lines: readonly string[];
}

export interface ExecuteOptions {
  readonly params?: readonly Param[];
  readonly signal?: AbortSignal;
}

export interface ExecuteResult {
  /** Rows the statement inserted, updated or deleted. */
  readonly changes: number;
  /** Row id of the last insert, where the engine reports one. */
  readonly lastInsertId?: string;
}

export type RelationKind =
  | "table"
  | "view"
  | "materialized view"
  | "foreign table"
  | "virtual table";

export interface TableSummary {
  /** Postgres schema; SQLite and D1 have none. */
  readonly schema?: string;
  readonly name: string;
  readonly kind: RelationKind;
}

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default?: string;
  /** Position in the primary key, from 1, when the column is part of it. */
  readonly primaryKey?: number;
}

export interface IndexInfo {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
  /** The engine's own definition, such as Postgres `CREATE INDEX ...`. */
  readonly definition?: string;
}

export interface ForeignKeyInfo {
  readonly columns: readonly string[];
  /** Referenced table, schema qualified in Postgres. */
  readonly table: string;
  readonly references: readonly string[];
}

export interface TableDetail extends TableSummary {
  readonly columns: readonly ColumnInfo[];
  readonly indexes: readonly IndexInfo[];
  readonly foreignKeys: readonly ForeignKeyInfo[];
}

export interface SchemaOptions {
  readonly signal?: AbortSignal;
}

export interface SampleOptions {
  /** Rows to read, 1 to `MAX_ROWS`. Default `DEFAULT_SAMPLE_ROWS`. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
