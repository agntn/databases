/** Built-in providers: registry metadata plus the import that brings in each engine. */

import type { ProviderEntry } from "../core/provider.ts";

/** Every provider shipped with the package. A provider missing here is invisible to `create()`. */
export const builtins: readonly ProviderEntry[] = [
  {
    key: "sqlite",
    title: "SQLite",
    reference: "sqlite:<path>, or a path ending in .db, .sqlite or .sqlite3",
    readOnly:
      "file opened read-only, and SQLite's authorizer denies every action but a read while the statement is prepared",
    load: () => import("./sqlite.ts").then((module) => module.Sqlite),
  },
  {
    key: "postgres",
    title: "Postgres",
    reference: "postgres://user:password@host:5432/database",
    readOnly:
      "a READ ONLY transaction with a statement timeout, over the extended protocol, which takes one statement",
    load: () => import("./postgres.ts").then((module) => module.Postgres),
  },
  {
    key: "d1",
    title: "Cloudflare D1",
    reference: "d1:<database name or id>, or d1://<account id>/<database>",
    readOnly:
      "the statement is prepared against an empty copy of the remote schema under SQLite's authorizer before it is sent",
    credentials:
      "CLOUDFLARE_API_TOKEN, or the cf CLI's login; the account from CLOUDFLARE_ACCOUNT_ID or the login",
    load: () => import("./d1.ts").then((module) => module.D1),
  },
];
