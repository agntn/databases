/**
 * The read-only policy for SQLite and D1, enforced by SQLite's own compiler.
 *
 * `setAuthorizer` sees every table, column, pragma and function a statement touches while it is
 * prepared, before a single row is read. Anything outside a short list of reads is denied, so a
 * writable CTE, an `ATTACH` or a `PRAGMA` that sets something fails to prepare. No regex over the
 * SQL decides it. D1 has no read-only mode of its own, so its statements are prepared against an
 * empty replica of the remote schema under the same authorizer before they are sent.
 */

import { constants, type DatabaseSync, type StatementSync } from "node:sqlite";
import { DatabasesError } from "./errors.ts";

/** Pragmas that only read; a value after `=` or in parentheses is an argument, not a setting. */
const READ_PRAGMAS = new Set([
  "collation_list",
  "compile_options",
  "database_list",
  "foreign_key_check",
  "foreign_key_list",
  "function_list",
  "index_info",
  "index_list",
  "index_xinfo",
  "integrity_check",
  "module_list",
  "pragma_list",
  "quick_check",
  "table_info",
  "table_list",
  "table_xinfo",
]);

/** Pragmas that set a value when given one, so they read only without it. */
const SETTING_PRAGMAS = new Set([
  "application_id",
  "auto_vacuum",
  "cache_size",
  "encoding",
  "foreign_keys",
  "freelist_count",
  "journal_mode",
  "page_count",
  "page_size",
  "schema_version",
  "user_version",
]);

/** Functions that reach outside the database. */
const DENIED_FUNCTIONS = new Set([
  "load_extension",
  "readfile",
  "writefile",
  "edit",
  "fts3_tokenizer",
]);

/**
 * Decides a pragma: one that only reads, or one that sets a value when given none.
 *
 * @param first - Pragma name.
 * @param second - Its argument or value, `null` without one.
 * @returns {number} `SQLITE_OK` or `SQLITE_DENY`.
 */
function decidePragma(first: string | null, second: string | null): number {
  const name = (first ?? "").toLowerCase();
  const reads = READ_PRAGMAS.has(name) || (SETTING_PRAGMAS.has(name) && second === null);
  return reads ? constants.SQLITE_OK : constants.SQLITE_DENY;
}

/**
 * Decides a function call: everything but the functions that reach outside the database.
 *
 * @param _first - Unused by SQLite for functions.
 * @param second - Function name.
 * @returns {number} `SQLITE_OK` or `SQLITE_DENY`.
 */
function decideFunction(_first: string | null, second: string | null): number {
  return DENIED_FUNCTIONS.has((second ?? "").toLowerCase())
    ? constants.SQLITE_DENY
    : constants.SQLITE_OK;
}

// Allows the action.
const allow = (): number => constants.SQLITE_OK;

/** The only actions a read may take; anything missing here is denied. */
const RULES = new Map<number, (first: string | null, second: string | null) => number>([
  [constants.SQLITE_SELECT, allow],
  [constants.SQLITE_READ, allow],
  [constants.SQLITE_RECURSIVE, allow],
  [constants.SQLITE_FUNCTION, decideFunction],
  [constants.SQLITE_PRAGMA, decidePragma],
]);

/**
 * The authorizer decision for one action of a statement being prepared.
 *
 * @param action - SQLite action code.
 * @param first - First argument: table, pragma or file name.
 * @param second - Second argument: column, pragma value or function name.
 * @returns {number} `SQLITE_OK` for a read, `SQLITE_DENY` for everything else.
 */
function decide(action: number, first: string | null, second: string | null): number {
  return RULES.get(action)?.(first, second) ?? constants.SQLITE_DENY;
}

/**
 * Makes every later `prepare` on this connection refuse anything but a read.
 *
 * @param db - Connection to guard.
 */
export function guardReads(db: DatabaseSync): void {
  db.setAuthorizer(decide);
}

/** What SQLite says when the authorizer denies an action. */
const DENIED = /not authorized|prohibited/iu;

/**
 * Prepares exactly one statement, refusing a second one after it.
 *
 * @param db - Connection, guarded by `guardReads` for a read.
 * @param sql - Statement text.
 * @param mode - `read` names a denied action as a write; `write` reports the engine's error.
 * @returns {StatementSync} The prepared statement.
 * @throws {DatabasesError} `refused` for a write in read mode or a second statement, `query` for blank SQL or SQL the engine rejects.
 */
export function prepareOne(db: DatabaseSync, sql: string, mode: "read" | "write"): StatementSync {
  /* Node 26.1 prepares blank SQL into an already finalized statement instead of throwing. */
  if (stripComments(sql).trim() === "") {
    throw new DatabasesError("No statement to run", { code: "query" });
  }
  /*
   * VACUUM asks the authorizer only when it runs, not when it is prepared, and a D1 statement is
   * only prepared here. VACUUM can only open a statement, so its first word decides.
   */
  if (mode === "read" && firstWord(sql) === "VACUUM") {
    throw new DatabasesError(
      "Refused: VACUUM rewrites the database file. Only reads run here; use execute for it",
      { code: "refused" },
    );
  }
  const statement = compile(db, sql, mode);
  assertSingle(statement, sql);
  return statement;
}

/**
 * Prepares the first statement of `sql`, naming an authorizer denial as a refused write.
 *
 * @param db - Connection.
 * @param sql - Statement text.
 * @param mode - Whether a denial means a write was refused.
 * @returns {StatementSync} The prepared statement.
 */
function compile(db: DatabaseSync, sql: string, mode: "read" | "write"): StatementSync {
  try {
    return db.prepare(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mode === "read" && DENIED.test(message)) {
      throw new DatabasesError(
        "Refused: the statement writes, changes a setting, attaches a file or calls a function outside the database. Only reads run here; use execute for a write",
        { code: "refused", engineCode: "SQLITE_AUTH", cause: error },
      );
    }
    throw new DatabasesError(message, { code: "query", cause: error });
  }
}

/**
 * Throws unless the prepared statement is all there is, comments and semicolons aside.
 *
 * @param statement - The first statement, as SQLite prepared it.
 * @param sql - The whole text.
 */
function assertSingle(statement: StatementSync, sql: string): void {
  const first = statement.sourceSQL;
  const rest = sql.startsWith(first) ? sql.slice(first.length) : "";
  if (stripComments(rest).trim() !== "") {
    throw new DatabasesError(
      "Refused: send one statement per call. Everything after the first `;` would have run too",
      { code: "refused" },
    );
  }
}

/**
 * The first keyword of a statement, past whitespace and comments.
 *
 * @param sql - Statement text.
 * @returns {string} The word in upper case, or an empty string.
 */
function firstWord(sql: string): string {
  return /^[A-Za-z]+/u.exec(stripComments(sql).trimStart())?.[0]?.toUpperCase() ?? "";
}

/**
 * Removes SQL comments and the semicolons between them, so only another statement is left.
 *
 * @param text - What follows the first statement.
 * @returns {string} The text without `--` and `/* *\/` comments and bare semicolons.
 */
function stripComments(text: string): string {
  /* One pass, so whichever comment opens first wins, as in `/* -- *\/ SELECT 1`. */
  return text.replaceAll(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|;/gu, " ");
}
