# @agntn/databases

[![npm version](https://npmx.dev/api/registry/badge/version/@agntn/databases)](https://npmx.dev/package/@agntn/databases)
[![npm downloads](https://npmx.dev/api/registry/badge/downloads/@agntn/databases)](https://npmx.dev/package/@agntn/databases)
[![license](https://npmx.dev/api/registry/badge/license/@agntn/databases)](https://npmx.dev/package/@agntn/databases)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/agntn/databases)

🗄️ Three engines, six tools, zero accidental writes. Your agent gets to look, not to touch.

## Why?

Postgres wants a URL and a role. D1 wants a Cloudflare token and a REST call. Handing an agent a psql shell and hoping it only types SELECT is a bad plan. Here the engine itself refuses the write, before anything is written.

Docs: [databases.agntn.dev](https://databases.agntn.dev).

## ✨ Features

- 🗃️ **One interface, three engines.** Inspect SQLite, Postgres and Cloudflare D1.
- 🔒 **Reads stay reads.** Each engine refuses a write on its own.
- 🛑 **One statement per call.** A second command makes the whole call fail.
- ✍️ **Writes need a switch.** `execute` is off unless `DATABASES_WRITE=1`.
- 📏 **Answers fit your context.** Get 50 rows by default, with a maximum of 1000 and a notice when more exist.
- 🧾 **Values stay in their lanes.** Escaped cell text cannot pretend to be another row.
- ⏱️ **Queries have a deadline.** Statements stop after 30 seconds.
- 🎛️ **Bring your own provider.** Use `register()` to add one.

## 📦 Install

```bash
pnpm add @agntn/databases
```

## 🚀 First call

```bash
npx @agntn/databases schema chinook.db
```

```text
/var/tmp/chinook/chinook.db (sqlite): 11 tables and views
Album  table
Artist  table
Customer  table
Employee  table
Genre  table
Invoice  table
InvoiceLine  table
MediaType  table
Playlist  table
PlaylistTrack  table
Track  table
Pass one as table for its columns, indexes and keys.
```

```bash
databases query chinook.db "SELECT a.Name, count(*) AS tracks FROM Track t JOIN Album al ON al.AlbumId = t.AlbumId JOIN Artist a ON a.ArtistId = al.ArtistId GROUP BY a.ArtistId ORDER BY tracks DESC" -n 3
```

```text
/var/tmp/chinook/chinook.db (sqlite): 3 rows, more not read (limit 3)
columns: ["Name","tracks"]
types: ["nvarchar(120)",null]
["Iron Maiden",213]
["U2",135]
["Led Zeppelin",114]
More rows exist. Narrow the query, aggregate it, or raise limit (up to 1000).
```

```bash
databases query chinook.db "DELETE FROM Track"
```

```text
Refused: the statement writes, changes a setting, attaches a file or calls a function outside the database. Only reads run here; use execute for a write [refused]
```

No key, no config, no server. Just a file. And yes, Iron Maiden leads the store with 213 tracks.

The bare `databases` command comes from `pnpm add -g @agntn/databases`, or use `pnpm exec databases` after a local install.

### Commands

| Command                     | What it does                                                   |
| --------------------------- | -------------------------------------------------------------- |
| `providers`                 | Engines and configured connections                             |
| `schema <database> [table]` | Tables of a database, or one table's columns, indexes and keys |
| `sample <database> <table>` | First rows of a table                                          |
| `query <database> <sql>`    | Run one read-only statement (`sql` can be `-` for stdin)       |
| `explain <database> <sql>`  | Plan of one statement                                          |
| `execute <database> <sql>`  | Run one statement that may write (needs `DATABASES_WRITE=1`)   |
| `mcp`                       | Run the MCP server over stdio                                  |

Find the options in the [CLI guide](https://databases.agntn.dev/guide/cli).

## 🧠 Library

```ts
import { open } from "@agntn/databases";

const shop = await open("postgres://reader:secret@localhost:5432/shop");
const { columns, rows, more } = await shop.query(
  "SELECT id, total FROM orders WHERE total > $1 ORDER BY total DESC",
  { params: [10], limit: 5 },
);

const orders = await shop.table("orders");
console.log(orders.columns.map((column) => `${column.name} ${column.type}`));
```

`open()` gives you a provider. You can also call `tables()`, `sample()`, `explain()` and `execute()`. Errors are `DatabasesError` instances with a code. The codes are `config`, `auth`, `connection`, `refused`, `query`, `timeout` and `unsupported`.

[Library](https://databases.agntn.dev/guide/library) · [Connections](https://databases.agntn.dev/guide/connections) · [Read-only](https://databases.agntn.dev/guide/read-only)

## 🗺️ Providers

| Provider | Reference                                   | Read-only through                                     |
| -------- | ------------------------------------------- | ----------------------------------------------------- |
| sqlite   | `sqlite:<path>` or a `.db` / `.sqlite` path | read-only file plus SQLite's authorizer               |
| postgres | `postgres://...`                            | READ ONLY transaction, one statement, 30 s timeout    |
| d1       | `d1:<name or id>`                           | authorizer check against a schema copy before sending |

You can also use a named connection from `DATABASES_<NAME>_URL`. SQLite accepts `.sqlite3` paths too. D1 also accepts `d1://<account id>/<database>` and uses `CLOUDFLARE_API_TOKEN` or the `cf` login. Its account comes from `CLOUDFLARE_ACCOUNT_ID` or the login.

[Provider details](https://databases.agntn.dev/providers)

## 🤖 Agents

Give your agent six tools: `databases_providers`, `databases_schema_get`, `databases_table_sample`, `databases_query`, `databases_explain` and `databases_execute`. Named connections keep passwords out of the agent's transcript. The providers list shows passwords as `***`. Pi asks you before `databases_execute` runs.

```bash
pi install npm:@agntn/databases
omp install @agntn/databases
```

For MCP, `databases mcp` serves the tools over stdio:

```json
{
  "mcpServers": {
    "databases": {
      "command": "npx",
      "args": ["-y", "@agntn/databases", "mcp"],
      "env": {
        "DATABASES_SHOP_URL": "postgres://reader:secret@localhost:5432/shop"
      }
    }
  }
}
```

For the AI SDK, install the `ai` peer dependency:

```ts
import { databasesAiTools } from "@agntn/databases/ai";
```

[Agent guide](https://databases.agntn.dev/guide/agents)

## 🚫 What this does not do

There is no MySQL, migration support, connection pool or session that outlives a call. For files and objects in buckets, use [@agntn/storages](https://github.com/agntn/storages).

## 🛠️ Development

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

Build uses obuild. Tests use Vitest through Vite+. Set `DATABASES_TEST_POSTGRES_URL` to a Postgres database you can write to. Without it, the Postgres suite is skipped.

## 💛 Thanks

[Claude for Open Source](https://claude.com/contact-sales/claude-for-oss) and [Codex for Open Source](https://developers.openai.com/community/codex-for-oss) help this package get built. Thanks also to Rasmus Porsager for [postgres.js](https://github.com/porsager/postgres), and to [Chinook](https://github.com/lerocha/chinook-database) for the sample database.

## 📄 License

[MIT](./LICENSE)
