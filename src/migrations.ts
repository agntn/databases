/** Migrations as numbered `.sql` files: which to run and in what order. The provider runs each. */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabasesError } from "./core/errors.ts";
import {
  checkMigration,
  isMigrationName,
  MAX_MIGRATION_LENGTH,
  type AppliedMigration,
  type MigrationScript,
} from "./core/migration-table.ts";
import type { Provider } from "./core/provider.ts";

/** The folder when none is given, relative to the working directory. */
export const DEFAULT_MIGRATIONS_DIRECTORY = "migrations";

/** Most `.sql` files one folder may hold. */
const MAX_FILES = 10_000;

/** A file the directory holds, read and hashed. */
export interface MigrationFile {
  readonly name: string;
  readonly path: string;
  /** SHA-256 of the file in lowercase hex. */
  readonly checksum: string;
  readonly sql: string;
}

/** Where every file and every record stands. */
export interface MigrationStatus {
  readonly directory: string;
  /** Files the database has run, as recorded. */
  readonly applied: readonly AppliedMigration[];
  /** Files the database hasn't run, in the order `applyMigrations` takes them. */
  readonly pending: readonly MigrationFile[];
  /** Applied files edited since; apply refuses while any are left. */
  readonly changed: readonly AppliedMigration[];
  /** Records with no file left in the directory. */
  readonly missing: readonly AppliedMigration[];
}

export interface MigrationDirectoryOptions {
  /** Default `migrations` under the working directory. */
  readonly directory?: string;
  readonly signal?: AbortSignal;
}

export interface ApplyMigrationsOptions extends MigrationDirectoryOptions {
  /** Last file to apply. Default every pending one. */
  readonly to?: string;
}

export interface ApplyMigrationsResult {
  readonly directory: string;
  /** What ran in this call, in order. */
  readonly applied: readonly AppliedMigration[];
  /** What is still waiting after it. */
  readonly pending: readonly string[];
}

export interface CreateMigrationOptions {
  /** Default `migrations` under the working directory. */
  readonly directory?: string;
  /** What the file starts with. Default a comment to replace. */
  readonly sql?: string;
}

export interface CreatedMigration {
  readonly name: string;
  readonly path: string;
}

/** The leading number of `0001_init.sql`, `undefined` for a name without one. */
const NUMBER = /^(\d+)_/u;

/** Words of a new migration's name; anything else becomes `_`. */
const SLUG_PART = /[^\da-z]+/gu;

/**
 * The directory as an absolute path.
 *
 * @param directory - What the caller passed, if anything.
 * @returns {string} The path.
 */
function directoryOf(directory: string | undefined): string {
  return resolve(
    directory === undefined || directory === "" ? DEFAULT_MIGRATIONS_DIRECTORY : directory,
  );
}

/**
 * Hex SHA-256 of a file's text, straight from Node.
 *
 * @param text - The file.
 * @returns {string} 64 lowercase hex digits.
 */
function checksumOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The `.sql` names of a directory, sorted, none when it doesn't exist yet.
 *
 * @param directory - Absolute path.
 * @returns {Promise<string[]>} File names.
 * @throws {DatabasesError} `config` when it can't be read or holds more than `MAX_FILES` files.
 */
async function sqlNames(directory: string): Promise<string[]> {
  let names: string[];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new DatabasesError(`Can't read the migrations in ${directory}: ${String(error)}`, {
      code: "config",
      cause: error,
    });
  }
  if (names.length > MAX_FILES) {
    throw new DatabasesError(`${directory} holds more than ${MAX_FILES} .sql files`, {
      code: "config",
    });
  }
  return names.toSorted(byNumber);
}

/**
 * Orders names by leading number, so `2_b` runs before `10_c`.
 *
 * @param a - One name.
 * @param b - Another.
 * @returns {number} Negative when `a` runs first.
 */
function byNumber(a: string, b: string): number {
  const left = Number(NUMBER.exec(a)?.[1] ?? Number.POSITIVE_INFINITY);
  const right = Number(NUMBER.exec(b)?.[1] ?? Number.POSITIVE_INFINITY);
  if (left !== right) return left < right ? -1 : 1;
  return a < b ? -1 : Number(a > b);
}

/**
 * Reads one migration file as text.
 *
 * @param path - Absolute path.
 * @returns {Promise<string>} Its contents.
 * @throws {DatabasesError} `config` when it can't be read or is too long.
 */
async function readSql(path: string): Promise<string> {
  let sql: string;
  try {
    sql = await readFile(path, "utf8");
  } catch (error) {
    throw new DatabasesError(`Can't read ${path}: ${String(error)}`, {
      code: "config",
      cause: error,
    });
  }
  if (sql.length > MAX_MIGRATION_LENGTH) {
    throw new DatabasesError(`${path} is longer than ${MAX_MIGRATION_LENGTH} characters`, {
      code: "config",
    });
  }
  return sql;
}

/**
 * Reads every migration in a directory, in the order they apply.
 *
 * @param options - The directory.
 * @returns {Promise<MigrationFile[]>} Every `.sql` file in run order, none for a missing folder.
 * @throws {DatabasesError} `config` for a file that can't be a migration, such as `my file.sql`.
 */
export async function readMigrations(
  options: Readonly<MigrationDirectoryOptions> = {},
): Promise<MigrationFile[]> {
  const directory = directoryOf(options.directory);
  const files: MigrationFile[] = [];
  for (const name of await sqlNames(directory)) {
    options.signal?.throwIfAborted();
    const path = join(directory, name);
    if (!isMigrationName(name)) {
      throw new DatabasesError(
        `${path} can't be a migration: name it like 0001_init.sql, with letters, digits, _, . and -`,
        { code: "config" },
      );
    }
    const sql = await readSql(path);
    files.push({ name, path, checksum: checksumOf(sql), sql });
  }
  return files;
}

/**
 * Compares a directory with what a database recorded.
 *
 * @example
 *   ```ts
 *   const shop = await open("shop");
 *   const { pending, changed } = await migrationStatus(shop, { directory: "db/migrations" });
 *   ```
 *
 * @param db - The database, from `open`.
 * @param options - The directory and cancellation.
 * @returns {Promise<MigrationStatus>} Applied, pending, changed and missing migrations.
 */
export async function migrationStatus(
  db: Provider,
  options: Readonly<MigrationDirectoryOptions> = {},
): Promise<MigrationStatus> {
  const directory = directoryOf(options.directory);
  const [files, applied] = await Promise.all([
    readMigrations({ ...options, directory }),
    db.appliedMigrations(options.signal ? { signal: options.signal } : {}),
  ]);
  const recorded = new Map(applied.map((migration) => [migration.name, migration]));
  const present = new Map(files.map((file) => [file.name, file]));
  return {
    directory,
    applied,
    pending: files.filter((file) => !recorded.has(file.name)),
    changed: applied.filter((migration) => {
      const file = present.get(migration.name);
      return file !== undefined && file.checksum !== migration.checksum;
    }),
    missing: applied.filter((migration) => !present.has(migration.name)),
  };
}

/**
 * The pending files up to and including `to`.
 *
 * @param status - Where things stand.
 * @param to - Last file to apply, or every pending one.
 * @returns {MigrationFile[]} What to run, in order.
 * @throws {DatabasesError} `query` when `to` names no pending file.
 */
function upTo(status: Readonly<MigrationStatus>, to: string | undefined): MigrationFile[] {
  if (to === undefined || to === "") return [...status.pending];
  const index = status.pending.findIndex((file) => file.name === to);
  if (index >= 0) return status.pending.slice(0, index + 1);
  const known = status.applied.some((migration) => migration.name === to);
  throw new DatabasesError(
    known
      ? `${to} is already applied`
      : `No pending migration named ${JSON.stringify(to)} in ${status.directory}`,
    { code: "query" },
  );
}

/**
 * Applies pending migrations in order, each in its own transaction. A failure rolls that file back.
 *
 * @example
 *   ```ts
 *   const shop = await open("shop");
 *   const { applied } = await applyMigrations(shop, { directory: "db/migrations" });
 *   ```
 *
 * @param db - The database, from `open`.
 * @param options - The directory, the last file to apply and cancellation.
 * @returns {Promise<ApplyMigrationsResult>} What ran and what still waits.
 * @throws {DatabasesError} `refused` for an edited file, else the failing file's error.
 */
export async function applyMigrations(
  db: Provider,
  options: Readonly<ApplyMigrationsOptions> = {},
): Promise<ApplyMigrationsResult> {
  const status = await migrationStatus(db, options);
  if (status.changed.length > 0) {
    throw new DatabasesError(
      `Refused: ${status.changed.map((migration) => migration.name).join(", ")} changed after it was applied. Put the old text back and write the change as a new migration`,
      { code: "refused", provider: db.key },
    );
  }
  const queue = upTo(status, options.to);
  const unrun = new Date(0).toISOString();
  for (const file of queue) checkMigration({ ...file, appliedAt: unrun });
  const applied: AppliedMigration[] = [];
  for (const { name, checksum, sql } of queue) {
    options.signal?.throwIfAborted();
    const script: MigrationScript = { name, checksum, sql, appliedAt: new Date().toISOString() };
    try {
      const outcome = await db.migrate(script, options.signal ? { signal: options.signal } : {});
      if (outcome.applied) applied.push({ name, checksum, appliedAt: script.appliedAt });
    } catch (error) {
      throw failedAt(name, applied, error);
    }
  }
  return {
    directory: status.directory,
    applied,
    pending: status.pending.slice(queue.length).map((file) => file.name),
  };
}

/**
 * A migration's failure, with what ran before it.
 *
 * @param name - The file that failed.
 * @param applied - What ran before it in this call.
 * @param error - What it threw.
 * @returns {unknown} The error to throw: the same `DatabasesError` code with the story in front.
 */
function failedAt(name: string, applied: readonly AppliedMigration[], error: unknown): unknown {
  if (!(error instanceof DatabasesError)) return error;
  const before =
    applied.length === 0 ? "Nothing applied" : `Applied ${applied.map((m) => m.name).join(", ")}`;
  return new DatabasesError(`${before}, then ${name} failed: ${error.message}`, {
    code: error.code,
    ...(error.provider ? { provider: error.provider } : {}),
    ...(error.engineCode ? { engineCode: error.engineCode } : {}),
    cause: error,
  });
}

/**
 * A name for a new migration: the next number, then the words in lower case.
 *
 * @param names - Files already there, sorted.
 * @param title - What the migration does, such as `add users`.
 * @returns {string} Such as `0003_add_users.sql`.
 * @throws {DatabasesError} `query` for a title with no letters or digits.
 */
function nextName(names: readonly string[], title: string): string {
  const slug = title
    .toLowerCase()
    .replaceAll(SLUG_PART, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 80);
  if (slug === "") {
    throw new DatabasesError("Name the migration with a few words, such as add users", {
      code: "query",
    });
  }
  const numbers = names
    .map((name) => NUMBER.exec(name)?.[1])
    .filter((digits) => digits !== undefined);
  const width = Math.max(4, ...numbers.map((digits) => digits.length));
  const next = Math.max(0, ...numbers.map(Number)) + 1;
  return `${String(next).padStart(width, "0")}_${slug.replace(/^\d+_/u, "")}.sql`;
}

/**
 * Writes the next numbered migration file. Never overwrites one.
 *
 * @example
 *   ```ts
 *   const { path } = await createMigration("add users", {
 *     sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);",
 *   });
 *   ```
 *
 * @param title - What the migration does, such as `add users`.
 * @param options - The directory and the first SQL.
 * @returns {Promise<CreatedMigration>} The new file's name and path.
 */
export async function createMigration(
  title: string,
  options: Readonly<CreateMigrationOptions> = {},
): Promise<CreatedMigration> {
  const directory = directoryOf(options.directory);
  const name = nextName(await sqlNames(directory), title);
  const path = join(directory, name);
  const sql =
    options.sql ?? `-- ${name}: write the SQL here. The whole file runs in one transaction.\n`;
  if (sql.length > MAX_MIGRATION_LENGTH) {
    throw new DatabasesError(`A migration is at most ${MAX_MIGRATION_LENGTH} characters`, {
      code: "query",
    });
  }
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path, sql.endsWith("\n") ? sql : `${sql}\n`, { flag: "wx" });
  } catch (error) {
    throw new DatabasesError(
      `Can't write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "config",
        cause: error,
      },
    );
  }
  return { name, path };
}
