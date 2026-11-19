/**
 * Schema and plan reading for every SQLite dialect, the local file and D1 alike. Each engine
 * passes the function that runs one read statement its own way.
 */

import { DatabasesError } from "./errors.ts";
import { MIGRATION_TABLE, type AppliedMigration } from "./migration-table.ts";
import type {
  Cell,
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  Param,
  PlanResult,
  RelationKind,
  TableDetail,
  TableSummary,
} from "./types.ts";

/** Rows of one read statement, as plain values. */
export type ReadRows = (
  sql: string,
  params: readonly Param[],
) => Promise<readonly (readonly Cell[])[]>;

const TABLES = `SELECT name, type, sql FROM sqlite_schema
WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
ORDER BY name`;

const FIND = `SELECT name, type, sql FROM sqlite_schema
WHERE type IN ('table', 'view') AND name = ?1 COLLATE NOCASE`;

const COLUMNS = `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?1) ORDER BY cid`;

const INDEXES = `SELECT il.name, il."unique", ii.name FROM pragma_index_list(?1) AS il
JOIN pragma_index_info(il.name) AS ii ORDER BY il.seq, ii.seqno`;

const FOREIGN_KEYS = `SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?1) ORDER BY id, seq`;

/**
 * A catalog cell as text; catalog values are names and SQL, never nested.
 *
 * @param cell - One cell.
 * @returns {string} Its text.
 */
function text(cell: Cell | undefined): string {
  if (typeof cell === "string") return cell;
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return cell === null || cell === undefined ? "" : JSON.stringify(cell);
}

/**
 * What a `sqlite_schema` row is.
 *
 * @param type - The `type` column.
 * @param sql - The `sql` column.
 * @returns {RelationKind} Table, view or virtual table.
 */
function kindOf(type: Cell | undefined, sql: Cell | undefined): RelationKind {
  if (type === "view") return "view";
  return typeof sql === "string" && /^\s*create\s+virtual\s+table/iu.test(sql)
    ? "virtual table"
    : "table";
}

/**
 * Tables and views.
 *
 * @param read - Runs one read statement.
 * @param hidden - Names to leave out, such as D1's `_cf_` tables.
 * @returns {Promise<TableSummary[]>} Sorted by name.
 */
export async function listTables(read: ReadRows, hidden?: RegExp): Promise<TableSummary[]> {
  const rows = await read(TABLES, []);
  return rows
    .filter((row) => typeof row[0] === "string" && !hidden?.test(row[0]))
    .map((row) => ({ name: text(row[0]), kind: kindOf(row[1], row[2]) }));
}

/**
 * Columns, indexes and foreign keys of one table or view.
 *
 * @param read - Runs one read statement.
 * @param name - Table name; SQLite has no schemas here, so a `main.` prefix is dropped.
 * @param hidden - Names that do not exist for the caller.
 * @returns {Promise<TableDetail>} The table.
 * @throws {DatabasesError} With code `query` when there is no such table.
 */
export async function describeTable(
  read: ReadRows,
  name: string,
  hidden?: RegExp,
): Promise<TableDetail> {
  const bare = name.replace(/^main\./iu, "");
  const found = (await read(FIND, [bare]))[0];
  if (!found || typeof found[0] !== "string" || hidden?.test(found[0])) {
    throw new DatabasesError(`No table or view named ${JSON.stringify(bare)}`, { code: "query" });
  }
  const table = found[0];
  const [columns, indexes, foreignKeys] = await Promise.all([
    read(COLUMNS, [table]),
    read(INDEXES, [table]),
    read(FOREIGN_KEYS, [table]),
  ]);
  return {
    name: table,
    kind: kindOf(found[1], found[2]),
    columns: columns.map((row): ColumnInfo => {
      const pk = Number(row[4]);
      return {
        name: text(row[0]),
        type: typeof row[1] === "string" && row[1] !== "" ? row[1] : "any",
        nullable: Number(row[2]) === 0,
        ...(row[3] === null || row[3] === undefined ? {} : { default: text(row[3]) }),
        ...(pk > 0 ? { primaryKey: pk } : {}),
      };
    }),
    indexes: groupIndexes(indexes),
    foreignKeys: groupForeignKeys(foreignKeys),
  };
}

/**
 * Index rows, one per column, folded into one entry per index.
 *
 * @param rows - Name, unique flag and column of each row.
 * @returns {IndexInfo[]} Indexes in list order.
 */
function groupIndexes(rows: readonly (readonly Cell[])[]): IndexInfo[] {
  const byName = new Map<string, { unique: boolean; columns: string[] }>();
  for (const row of rows) {
    const key = text(row[0]);
    const entry = byName.get(key) ?? { unique: Number(row[1]) === 1, columns: [] };
    entry.columns.push(row[2] === null ? "<expression>" : text(row[2]));
    byName.set(key, entry);
  }
  return [...byName].map(([name, entry]) => ({ name, ...entry }));
}

/**
 * Foreign key rows, one per column, folded into one entry per key.
 *
 * @param rows - Id, referenced table, local column and referenced column of each row.
 * @returns {ForeignKeyInfo[]} Keys in id order.
 */
function groupForeignKeys(rows: readonly (readonly Cell[])[]): ForeignKeyInfo[] {
  const byId = new Map<string, { table: string; columns: string[]; references: string[] }>();
  for (const row of rows) {
    const key = text(row[0]);
    const entry = byId.get(key) ?? { table: text(row[1]), columns: [], references: [] };
    entry.columns.push(text(row[2]));
    entry.references.push(row[3] === null ? "<primary key>" : text(row[3]));
    byId.set(key, entry);
  }
  return [...byId.values()];
}

/**
 * `EXPLAIN QUERY PLAN` rows as an indented tree.
 *
 * @param rows - Id, parent, unused and detail of each step.
 * @returns {PlanResult} One line per step.
 */
export function planTree(rows: readonly (readonly Cell[])[]): PlanResult {
  const depth = new Map<number, number>();
  const lines: string[] = [];
  for (const row of rows) {
    const id = Number(row[0]);
    const parent = Number(row[1]);
    const level = (depth.get(parent) ?? -1) + 1;
    depth.set(id, level);
    lines.push(`${"  ".repeat(level)}${text(row[3])}`);
  }
  return { lines };
}

const HAS_MIGRATIONS = `SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '${MIGRATION_TABLE}'`;

const APPLIED = `SELECT name, checksum, applied_at FROM ${MIGRATION_TABLE} ORDER BY name`;

/**
 * The rows of the migration table, none when it doesn't exist yet.
 *
 * @param read - Runs one read statement.
 * @returns {Promise<AppliedMigration[]>} Oldest name first.
 */
export async function appliedFrom(read: ReadRows): Promise<AppliedMigration[]> {
  if ((await read(HAS_MIGRATIONS, [])).length === 0) return [];
  return (await read(APPLIED, [])).map((row) => ({
    name: text(row[0]),
    checksum: text(row[1]),
    appliedAt: text(row[2]),
  }));
}
