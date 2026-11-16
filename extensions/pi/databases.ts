import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { registerPiTools } from "@agntn/tools/pi";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type * as DatabasesTools from "../../dist/tools.d.mts";

const sourceModuleUrl = new URL("../../src/tools.ts", import.meta.url);
const distributionModuleUrl = new URL("../../dist/tools.mjs", import.meta.url);

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
 * Registers the databases tools; the executors load on the first call.
 *
 * @param pi - Pi extension API.
 */
export default async function databasesExtension(pi: ExtensionAPI): Promise<void> {
  const { databasesTools } = await loadTools();
  registerPiTools(pi, databasesTools);
}
