/**
 * Builds `app/data/samples.json`, everything the landing shows about the library.
 *
 * Each query is the real tool executor run against a small record shop written to a fixed path
 * here, each verdict is the real read guard, each reference the real parser. Nothing reaches the
 * network, so the build and the root test that compares this file stay offline.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../../", import.meta.url);
const output = new URL("app/data/samples.json", new URL("docs/", root));

/** A path that reads the same on every machine, since it ends up in the answers. */
const DIRECTORY = "/var/tmp/databases-landing";
const FILE = `${DIRECTORY}/shop.db`;

const SHOP = `
CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE albums (id INTEGER PRIMARY KEY, artist_id INTEGER NOT NULL REFERENCES artists (id), title TEXT NOT NULL, year INTEGER);
CREATE TABLE tracks (id INTEGER PRIMARY KEY, album_id INTEGER NOT NULL REFERENCES albums (id), title TEXT NOT NULL, seconds INTEGER NOT NULL, price NUMERIC(4,2) NOT NULL DEFAULT 0.99);
CREATE INDEX tracks_album ON tracks (album_id);
INSERT INTO artists VALUES (1, 'Iron Maiden'), (2, 'Daft Punk'), (3, 'Nina Simone');
INSERT INTO albums VALUES
  (1, 1, 'Powerslave', 1984), (2, 1, 'Piece of Mind', 1983),
  (3, 2, 'Discovery', 2001), (4, 3, 'Pastel Blues', 1965);
INSERT INTO tracks (album_id, title, seconds) VALUES
  (1, 'Aces High', 271), (1, '2 Minutes to Midnight', 360), (1, 'Rime of the Ancient Mariner', 818),
  (2, 'The Trooper', 252), (2, 'Flight of Icarus', 231),
  (3, 'One More Time', 320), (3, 'Digital Love', 301), (3, 'Harder, Better, Faster, Stronger', 224),
  (4, 'Sinnerman', 622), (4, 'Strange Fruit', 158);
`;

/** The queries the hero walks through, each one tool call. */
export const QUERIES = [
  {
    id: "longest",
    title: "The longest tracks",
    sql: "SELECT t.title, a.name, t.seconds FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists a ON a.id = al.artist_id ORDER BY t.seconds DESC",
    limit: 3,
  },
  {
    id: "albums",
    title: "Albums of one artist",
    sql: "SELECT title, year FROM albums WHERE artist_id = ? ORDER BY year",
    params: [1],
  },
  {
    id: "delete",
    title: "A write, refused",
    sql: "DELETE FROM tracks WHERE seconds > 600",
  },
  {
    id: "stacked",
    title: "A second statement, refused",
    sql: "SELECT count(*) FROM tracks; DROP TABLE tracks",
  },
];

/** Statements the read guard decides on, the same text for the file and for D1. */
export const STATEMENTS = [
  "SELECT * FROM tracks WHERE seconds > 300",
  "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 3) SELECT i FROM n",
  "PRAGMA table_info(tracks)",
  "UPDATE tracks SET price = 0",
  "WITH gone AS (SELECT 1) DELETE FROM tracks",
  "ATTACH 'other.db' AS other",
  "PRAGMA foreign_keys = off",
  "SELECT 1; DROP TABLE tracks",
];

/** References as a caller writes them. */
export const REFERENCES = [
  "shop",
  "postgres://reader@db.internal:5432/shop",
  "/srv/data/shop.db",
  "sqlite:/var/data/app.sqlite",
  "d1:shop-prod",
];

/**
 * The outcome of a call: its answer, or the line its failure gives the model.
 *
 * @param {() => Promise<{ content: { text: string }[]; details: object }>} call - The executor call.
 * @returns {Promise<object>} Text plus either the result or the error code.
 */
async function outcome(call) {
  try {
    const answer = await call();
    return { text: answer.content[0].text, result: answer.details };
  } catch (error) {
    return { text: error.message, error: { code: error.code ?? "query" } };
  }
}

/**
 * The verdict of the read guard on one statement, for a file and for a D1 schema copy.
 *
 * @param {string} sql - The statement.
 * @param {(job: object) => Promise<unknown>} runChild - The SQLite runner.
 * @param {string[]} schema - The shop's CREATE statements.
 * @returns {Promise<{ sql: string; sqlite: string; d1: string }>} `ok` or the error code.
 */
async function verdict(sql, runChild, schema) {
  const decide = async (job) => {
    try {
      await runChild(job);
      return "ok";
    } catch (error) {
      return error.code ?? "query";
    }
  };
  return {
    sql,
    sqlite: await decide({ kind: "file", path: FILE, write: false, steps: [{ sql, params: [], limit: 1 }] }),
    d1: await decide({ kind: "check", schema, sql, write: false }),
  };
}

/**
 * Runs every sample through the library.
 *
 * @returns {Promise<object>} What `app/data/samples.json` holds.
 */
export async function buildSamples() {
  rmSync(DIRECTORY, { recursive: true, force: true });
  mkdirSync(DIRECTORY, { recursive: true });
  const db = new DatabaseSync(FILE);
  db.exec(SHOP);
  const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL").all().map((row) => row.sql);
  db.close();

  const source = (path) => import(new URL(`src/${path}`, root).href);
  const [{ runQuery }, { runChild }, { parseReference }, { builtins }, { databasesTools }] = await Promise.all([
    source("tool-operations.ts"),
    source("core/sqlite-protocol.ts"),
    source("core/reference.ts"),
    source("providers/index.ts"),
    source("tools.ts"),
  ]);

  const queries = [];
  for (const query of QUERIES) {
    const { id, title, ...input } = query;
    queries.push({ id, title, ...input, ...(await outcome(() => runQuery({ database: FILE, ...input }))) });
  }
  const verdicts = [];
  for (const sql of STATEMENTS) verdicts.push(await verdict(sql, runChild, schema));
  const env = { DATABASES_SHOP_URL: "postgres://reader:hunter2@db.internal:5432/shop" };
  const references = REFERENCES.map((reference) => {
    const { provider, label, name } = parseReference(reference, env);
    return { reference, provider, label, ...(name ? { name } : {}) };
  });

  rmSync(DIRECTORY, { recursive: true, force: true });
  return {
    database: FILE,
    engines: builtins.map(({ load: _load, ...meta }) => meta),
    tools: databasesTools.map((tool) => ({ name: tool.name, title: tool.title, effect: tool.effect })),
    queries,
    verdicts,
    references,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(output, `${JSON.stringify(await buildSamples(), null, 2)}\n`);
}
