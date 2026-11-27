/** The migration table and the checks a script passes before any provider runs it. */

import { DatabasesError } from "./errors.ts";

/** Applied migrations live here, next to the tables they built. */
export const MIGRATION_TABLE = "databases_migrations";

/** Longest migration file accepted, in UTF-16 code units. */
export const MAX_MIGRATION_LENGTH = 5_000_000;

/** Deadline of one migration in SQLite and Postgres. */
export const MIGRATION_TIMEOUT_MS = 300_000;

/**
 * Creates the table inside the first migration's transaction, so a failed run leaves none.
 *
 * @param table - The table, schema qualified where the engine needs it.
 * @returns {string} The statement.
 */
export function createMigrationTable(table: string = MIGRATION_TABLE): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;
}

/** `0001_init.sql`: no path, no quote, no leading dot. */
const NAME = /^\w[\w.-]{0,199}\.sql$/u;

const CHECKSUM = /^[\da-f]{64}$/u;

/** What `Date#toISOString` writes; D1 gets it as a literal. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

const NAME_RULE =
  "A migration name is a file name such as 0001_init.sql: letters, digits, _, . and -, ending in .sql";

/**
 * Whether a file name can be a migration, as the table stores it.
 *
 * @param name - File name, no directory.
 * @returns {boolean} `true` for names such as `0001_init.sql`.
 */
export function isMigrationName(name: unknown): name is string {
  return typeof name === "string" && NAME.test(name);
}

/** One migration as a provider runs it. */
export interface MigrationScript {
  /** File name, such as `0001_init.sql`. */
  readonly name: string;
  /** SHA-256 of the file in lowercase hex. */
  readonly checksum: string;
  /** The whole file. */
  readonly sql: string;
  /** When it ran, as ISO 8601. */
  readonly appliedAt: string;
}

/** A row of the migration table. */
export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrateOptions {
  readonly signal?: AbortSignal;
}

/**
 * The insert that records one migration, with placeholders in the engine's own style.
 *
 * @param style - `?` for SQLite and D1, `$` for Postgres.
 * @param table - The table, schema qualified where the engine needs it.
 * @returns {string} The statement, taking name, checksum and time in that order.
 */
export function recordMigration(style: "?" | "$", table: string = MIGRATION_TABLE): string {
  const values = style === "?" ? "?, ?, ?" : "$1, $2, $3";
  return `INSERT INTO ${table} (name, checksum, applied_at) VALUES (${values})`;
}

/**
 * Whether a recorded migration matches the script, so a rerun can skip it.
 *
 * @param script - What the caller wants to run.
 * @param recorded - The checksum on record for that name, if any.
 * @returns {boolean} `true` when the record is the same file, `false` when there is none.
 * @throws {DatabasesError} `refused` when the record holds another text under that name.
 */
export function alreadyApplied(
  script: Readonly<MigrationScript>,
  recorded: string | undefined,
): boolean {
  if (recorded === undefined) return false;
  if (recorded === script.checksum) return true;
  throw new DatabasesError(
    `Refused: ${script.name} was applied with different text. Another run got there first; check the database before going on`,
    { code: "refused" },
  );
}

/**
 * The record of one checked migration as SQL literals, for D1.
 *
 * @param script - A checked script.
 * @returns {string} The insert.
 */
export function recordMigrationLiteral(script: Readonly<MigrationScript>): string {
  const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;
  return `INSERT INTO ${MIGRATION_TABLE} (name, checksum, applied_at) VALUES (${literal(script.name)}, ${literal(script.checksum)}, ${literal(script.appliedAt)})`;
}

/**
 * Whether a script holds SQL past its comments, read the engine's way.
 *
 * @param sql - The script.
 * @param nested - Whether block comments nest, as in Postgres.
 * @returns {boolean} `true` when there is SQL to run.
 */
export function hasStatements(sql: string, nested = false): boolean {
  const filler = /(?:\s|;|--[^\n\r]*)*/uy;
  let at = 0;
  for (;;) {
    filler.lastIndex = at;
    filler.exec(sql);
    at = filler.lastIndex;
    if (!sql.startsWith("/*", at)) return at < sql.length;
    at = blockCommentEnd(sql, at, nested);
  }
}

/**
 * Where the block comment opening at `start` closes, or the end of the text.
 *
 * @param sql - The script.
 * @param start - Index of its `/*`.
 * @param nested - Whether an inner `/*` needs its own `*\/`.
 * @returns {number} The index just past the closing `*\/`.
 */
function blockCommentEnd(sql: string, start: number, nested: boolean): number {
  const marks = nested ? /\/\*|\*\//gu : /\*\//gu;
  marks.lastIndex = start + 2;
  let depth = 1;
  for (let mark = marks.exec(sql); mark !== null; mark = marks.exec(sql)) {
    depth += mark[0] === "/*" ? 1 : -1;
    if (depth === 0) return marks.lastIndex;
  }
  return sql.length;
}

/**
 * Checks a script before a provider sends it.
 *
 * @param script - What `migrate` got.
 * @param engine - Provider key; `postgres` nests block comments.
 * @throws {DatabasesError} `query` for a bad name, checksum or time, or a script with no SQL.
 */
export function checkMigration(script: Readonly<MigrationScript>, engine = ""): void {
  const problem = recordProblem(script) ?? sqlProblem(script, engine === "postgres");
  if (problem !== undefined) throw new DatabasesError(problem, { code: "query" });
}

/**
 * What is wrong with the fields that go into the table, if anything.
 *
 * @param script - The script.
 * @returns {string | undefined} The problem.
 */
function recordProblem(script: Readonly<MigrationScript>): string | undefined {
  if (!isMigrationName(script.name)) return NAME_RULE;
  if (typeof script.checksum !== "string" || !CHECKSUM.test(script.checksum)) {
    return "A migration checksum is SHA-256 in 64 lowercase hex digits";
  }
  if (typeof script.appliedAt !== "string" || !ISO_TIME.test(script.appliedAt)) {
    return "appliedAt is a UTC time as Date#toISOString writes it";
  }
  return undefined;
}

/**
 * What is wrong with the SQL itself, if anything.
 *
 * @param script - The script, its record already checked.
 * @param nested - Whether block comments nest.
 * @returns {string | undefined} The problem.
 */
function sqlProblem(script: Readonly<MigrationScript>, nested: boolean): string | undefined {
  if (typeof script.sql !== "string" || script.sql.length > MAX_MIGRATION_LENGTH) {
    return `A migration is text of at most ${MAX_MIGRATION_LENGTH} characters`;
  }
  if (script.sql.includes("\0")) return `${script.name} holds a NUL, where SQLite stops reading`;
  if (!hasStatements(script.sql, nested)) return `${script.name} has no SQL yet, only comments`;
  return undefined;
}
