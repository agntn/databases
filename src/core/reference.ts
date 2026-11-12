/**
 * Turns what a caller names a database by into a provider and a target.
 *
 * A reference is a connection URL (`postgres://`), a SQLite path (`sqlite:` or anything that looks
 * like a file), a D1 database (`d1:<name or id>`), or the name of a connection set in the
 * environment as `DATABASES_<NAME>_URL`. A named connection keeps the URL, and its password, out
 * of the transcript: the agent only ever sees the name.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabasesError } from "./errors.ts";

export interface DatabaseTarget {
  /** Registry key of the provider: `sqlite`, `postgres` or `d1`. */
  readonly provider: string;
  /** File path, connection URL, or D1 database name or id. */
  readonly target: string;
  /** Cloudflare account of a `d1://<account>/<database>` reference. */
  readonly account?: string;
  /** The reference with any password replaced, safe to show. */
  readonly label: string;
  /** The connection name, when the reference was one. */
  readonly name?: string;
}

export interface NamedConnection {
  readonly name: string;
  /** The variable that holds it. */
  readonly variable: string;
  readonly provider: string;
  /** The URL with any password replaced. */
  readonly label: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const NAME = /^[A-Za-z][\w-]*$/u;
const VARIABLE = /^DATABASES_(\w+)_URL$/u;
const SQLITE_FILE = /\.(?:db|db3|sqlite|sqlite3|s3db|sl3)$/iu;

const FORMS =
  "Use a postgres:// URL, sqlite:<path>, d1:<database>, or the name of a connection set as DATABASES_<NAME>_URL";

/**
 * The variable a connection name is read from.
 *
 * @param name - Connection name, any case, `-` or `_` between words.
 * @returns {string} Such as `DATABASES_SHOP_PROD_URL` for `shop-prod`.
 */
export function connectionVariable(name: string): string {
  return `DATABASES_${name.toUpperCase().replaceAll("-", "_")}_URL`;
}

/**
 * Resolves a reference to the provider and target it names.
 *
 * @param reference - URL, path, `d1:` reference or connection name.
 * @param env - Where connection names are looked up. Default `process.env`.
 * @returns {DatabaseTarget} The provider, target and a label without secrets.
 * @throws {DatabasesError} With code `config` when the reference names nothing usable.
 */
export function parseReference(reference: string, env: Environment = process.env): DatabaseTarget {
  const trimmed = reference.trim();
  if (trimmed === "") throw new DatabasesError(`No database given. ${FORMS}`, { code: "config" });
  const direct = parseDirect(trimmed);
  if (direct) return direct;
  if (!NAME.test(trimmed)) {
    throw new DatabasesError(`Can't tell which database ${JSON.stringify(trimmed)} is. ${FORMS}`, {
      code: "config",
    });
  }
  const variable = connectionVariable(trimmed);
  const value = env[variable]?.trim();
  if (!value) {
    const known = listConnections(env).map((connection) => connection.name);
    throw new DatabasesError(
      `No connection named ${JSON.stringify(trimmed)}: ${variable} is not set. ${
        known.length > 0 ? `Configured: ${known.join(", ")}` : "No connection is configured"
      }`,
      { code: "config" },
    );
  }
  const named = parseDirect(value);
  if (!named) {
    throw new DatabasesError(`${variable} holds no database URL. ${FORMS}`, { code: "config" });
  }
  return { ...named, name: trimmed.toLowerCase() };
}

/**
 * Every connection named in the environment, with its password replaced.
 *
 * @param env - Where to look. Default `process.env`.
 * @returns {NamedConnection[]} Sorted by name; a variable holding no usable URL is left out.
 */
export function listConnections(env: Environment = process.env): NamedConnection[] {
  const found: NamedConnection[] = [];
  for (const [variable, value] of Object.entries(env)) {
    const match = VARIABLE.exec(variable);
    const parsed = match && value ? parseDirect(value.trim()) : undefined;
    if (!match?.[1] || !parsed) continue;
    found.push({
      name: match[1].toLowerCase().replaceAll("_", "-"),
      variable,
      provider: parsed.provider,
      label: parsed.label,
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A `file:` URL as a SQLite target.
 *
 * @param value - The URL.
 * @returns {DatabaseTarget} The target.
 */
function fileTarget(value: string): DatabaseTarget {
  let path: string;
  try {
    path = fileURLToPath(value);
  } catch {
    throw new DatabasesError(`${JSON.stringify(value)} is not a file URL`, { code: "config" });
  }
  return sqliteTarget(path);
}

// Prefixes that name an engine, and how the rest of the reference is read.
const SCHEMES: readonly (readonly [string, (value: string) => DatabaseTarget])[] = [
  ["postgres://", (value) => ({ provider: "postgres", target: value, label: redactUrl(value) })],
  ["postgresql://", (value) => ({ provider: "postgres", target: value, label: redactUrl(value) })],
  ["d1:", (value) => parseD1(value.slice(3))],
  ["sqlite:", (value) => sqliteTarget(value.slice(7).replace(/^\/\/(?=\/)/u, ""))],
  ["file:", fileTarget],
];

/**
 * Whether a bare reference reads as a SQLite path rather than a connection name.
 *
 * @param value - Trimmed reference.
 * @returns {boolean} True for an absolute, relative or home path, or a SQLite file name.
 */
function looksLikePath(value: string): boolean {
  return /^(?:\/|\.\.?\/|~\/)/u.test(value) || SQLITE_FILE.test(value);
}

/**
 * Reads a reference that names its engine, or returns nothing for a bare word.
 *
 * @param value - Trimmed reference.
 * @returns {DatabaseTarget | undefined} The target, or nothing.
 */
function parseDirect(value: string): DatabaseTarget | undefined {
  const lower = value.toLowerCase();
  const scheme = SCHEMES.find(([prefix]) => lower.startsWith(prefix));
  if (scheme) return scheme[1](value);
  return looksLikePath(value) ? sqliteTarget(value) : undefined;
}

/**
 * A SQLite target with `~` expanded and a relative path made absolute against the cwd.
 *
 * @param path - Path as given.
 * @returns {DatabaseTarget} The target.
 */
function sqliteTarget(path: string): DatabaseTarget {
  if (path === "" || path === ":memory:") {
    throw new DatabasesError("A SQLite reference needs a file path", { code: "config" });
  }
  const expanded = path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
  const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
  return { provider: "sqlite", target: absolute, label: absolute };
}

/**
 * `d1:<database>` or `d1://<account>/<database>`, the database a name or an id.
 *
 * @param rest - Everything after `d1:`.
 * @returns {DatabaseTarget} The target.
 */
function parseD1(rest: string): DatabaseTarget {
  const explicit = /^\/\/([\da-f]{32})\/([^/]+)$/iu.exec(rest);
  const database = explicit ? explicit[2] : rest;
  if (!database || !/^[\w.-]{1,128}$/u.test(database)) {
    throw new DatabasesError(
      "A D1 reference is d1:<database> or d1://<account id>/<database>, the database a name or an id",
      { code: "config" },
    );
  }
  const account = explicit?.[1]?.toLowerCase();
  return {
    provider: "d1",
    target: database,
    ...(account ? { account } : {}),
    label: account ? `d1://${account}/${database}` : `d1:${database}`,
  };
}

/**
 * A connection URL with its password, and any password or token parameter, replaced by `***`.
 *
 * @param url - Connection URL.
 * @returns {string} The same URL without secrets.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/pass|secret|token|key/iu.test(key)) parsed.searchParams.set(key, "***");
    }
    return parsed.toString();
  } catch {
    return url.replace(/(\/\/[^:/@]*:)[^@/]*@/u, "$1***@");
  }
}

/**
 * The secret parts of a target, so an error quoting them can be scrubbed.
 *
 * @param target - Resolved target.
 * @returns {string[]} The password, raw and decoded, and secret parameters; none for a file.
 */
export function secretsOf(target: DatabaseTarget): string[] {
  if (target.provider !== "postgres") return [];
  try {
    const parsed = new URL(target.target);
    const secrets = [parsed.password, decodeURIComponent(parsed.password)];
    for (const [key, value] of parsed.searchParams) {
      if (/pass|secret|token|key/iu.test(key)) secrets.push(value);
    }
    return secrets.filter((secret) => secret.length >= 3);
  } catch {
    return [];
  }
}

/**
 * Replaces every secret in a message.
 *
 * @param message - Text that may quote a secret.
 * @param secrets - Values to hide.
 * @returns {string} The message with each one replaced by `***`.
 */
export function scrub(message: string, secrets: readonly string[]): string {
  let text = message;
  for (const secret of secrets) text = text.replaceAll(secret, "***");
  return text;
}
