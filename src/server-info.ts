/** Server identity for stdio and the CLI, in a module that loads no MCP SDK. */

import { version } from "./version.ts";

export const serverInfo = {
  name: "databases",
  version,
  description: "Schema, read-only queries and query plans for SQLite, Postgres and Cloudflare D1",
} as const;
