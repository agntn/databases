import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { registerPiTools } from "@agntn/tools/pi";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type * as DatabasesTools from "../../dist/tools.d.mts";

const sourceModuleUrl = new URL("../../src/tools.ts", import.meta.url);
const distributionModuleUrl = new URL("../../dist/tools.mjs", import.meta.url);

/** Longest piece of SQL the confirmation shows; the call still runs the whole statement. */
const PREVIEW_LENGTH = 2000;

/**
 * Loads the tool definitions, from the source in a checkout and the build in the package.
 *
 * @returns {Promise<typeof DatabasesTools>} The definitions and the executor loader.
 */
function loadTools(): Promise<typeof DatabasesTools> {
  return import(
    existsSync(fileURLToPath(sourceModuleUrl)) ? sourceModuleUrl.href : distributionModuleUrl.href
  ) as Promise<typeof DatabasesTools>;
}

/**
 * Registers the databases tools; the executors load on the first call. A statement that may
 * write asks the user first.
 *
 * @param pi - Pi extension API.
 */
export default async function databasesExtension(pi: ExtensionAPI): Promise<void> {
  const { databasesTools } = await loadTools();
  registerPiTools(pi, databasesTools, {
    confirm: {
      databases_execute: (input) => {
        const sql = typeof input["sql"] === "string" ? input["sql"] : "";
        return {
          title: "Run a statement that may change the database?",
          message: `Database: ${String(input["database"])}\n\n${sql.slice(0, PREVIEW_LENGTH)}${sql.length > PREVIEW_LENGTH ? "\n…" : ""}`,
        };
      },
    },
  });
}
