/** What the site knows about the library, read from `app/data/samples.json`, never typed in. */

import recorded from "../data/samples.json";

export interface Engine {
  readonly key: string;
  readonly title: string;
  readonly reference: string;
  readonly readOnly: string;
  readonly credentials?: string;
}

export interface EngineView extends Engine {
  /** Monochrome glyph for the reticle and the cells. */
  readonly icon: string;
  /** Short name for a label. */
  readonly name: string;
  readonly to: string;
}

/** Brand glyphs from the monochrome `simple-icons` set; the subject is the engine. */
const ICONS: Readonly<Record<string, string>> = {
  sqlite: "i-simple-icons-sqlite",
  postgres: "i-simple-icons-postgresql",
  d1: "i-simple-icons-cloudflare",
};

const NAMES: Readonly<Record<string, string>> = { sqlite: "SQLite", postgres: "Postgres", d1: "D1" };

/** Every built-in engine, in registry order. */
export const ENGINES: readonly EngineView[] = (recorded.engines as Engine[]).map((engine) => ({
  ...engine,
  icon: ICONS[engine.key] ?? "i-lucide-database",
  name: NAMES[engine.key] ?? engine.title,
  to: `/providers/${engine.key}`,
}));

/** Every tool the package registers, with its effect. */
export const TOOLS = recorded.tools as readonly { name: string; title: string; effect: string }[];

/**
 * One engine by key.
 *
 * @param key - Registry key.
 * @returns {EngineView} The engine, or the first one for an unknown key.
 */
export function engineView(key: string): EngineView {
  return ENGINES.find((engine) => engine.key === key) ?? ENGINES[0]!;
}

/** The SQLite file the queries ran against. */
export const DATABASE: string = recorded.database;

/** Statements and what the read guard said about each, for a file and for a D1 schema copy. */
export const VERDICTS = recorded.verdicts as readonly { sql: string; sqlite: string; d1: string }[];

/** References and what the parser made of them. */
export const REFERENCES = recorded.references as readonly {
  reference: string;
  provider: string;
  label: string;
  name?: string;
}[];
