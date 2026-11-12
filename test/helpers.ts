/** A SQLite file every test can read, and the Postgres a test may be pointed at. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Rows of `items`; the third label carries a line break and a right-to-left override. */
export const HOSTILE_LABEL = "line\nbreak\u202Eend";

const SCHEMA = `
CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER REFERENCES owners (id),
  label TEXT,
  data BLOB,
  big INTEGER,
  created TEXT DEFAULT '2026-01-01'
);
CREATE UNIQUE INDEX items_label ON items (label);
CREATE VIEW owned AS SELECT items.id, owners.name FROM items JOIN owners ON owners.id = items.owner_id;
INSERT INTO owners VALUES (1, 'Ada'), (2, 'Linus');
INSERT INTO items (owner_id, label, data, big) VALUES
  (1, 'a', x'00ff', 9007199254740993),
  (1, 'b', NULL, 2),
  (2, '${HOSTILE_LABEL.replace("\n", "' || char(10) || '").replace("\u202E", "' || char(8238) || '")}', zeroblob(100), NULL);
`;

/**
 * Creates a fresh SQLite file with the fixture schema.
 *
 * @returns {{ path: string, dispose: () => void }} The file and its cleanup.
 */
export function sqliteFixture(): { path: string; dispose: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "databases-sqlite-"));
  const path = join(directory, "shop.db");
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.close();
  return { path, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

/**
 * Reads a table straight from the file, to check what a write did or didn't do.
 *
 * @param path - The fixture file.
 * @param sql - A query.
 * @returns {unknown[]} Its rows.
 */
export function readDirect(path: string, sql: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/** A Postgres a test may write to, such as the CI service; the suite skips without it. */
export const postgresUrl = process.env["DATABASES_TEST_POSTGRES_URL"];
