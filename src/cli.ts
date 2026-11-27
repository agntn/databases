#!/usr/bin/env node

import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "@agntn/tools/cli";
import { DatabasesError } from "./core/errors.ts";
import type { createMcpServer } from "./mcp.ts";
import { serverInfo } from "./server-info.ts";
import { databasesTools } from "./tools.ts";

/** The same file from `src/cli.ts` and `dist/cli.mjs`; the npm package ships only `dist`. */
const sourceMcp = new URL("../src/mcp.ts", import.meta.url);
const sourceMcpPath = fileURLToPath(sourceMcp);

/**
 * Narrows the module a runtime URL import returned, which TypeScript types as `any`.
 * @param value - The imported module namespace.
 * @returns {value is { createMcpServer: typeof createMcpServer }} Whether it exports the server.
 */
function isMcpModule(value: unknown): value is { createMcpServer: typeof createMcpServer } {
  return typeof value === "object" && value !== null && "createMcpServer" in value;
}

/**
 * A checkout serves the live source with its restart guard, so a change needs no `pnpm build`.
 * Node never strips types under `node_modules`, nor with `--no-strip-types`;
 * `DATABASES_DIST=1` keeps the bundle for tests.
 * @param argv - Every argument after the bin.
 * @returns {boolean} Whether the line is a bare `mcp` and the source is there to serve.
 */
function servesSource(argv: readonly string[]): boolean {
  return (
    argv.length === 1 &&
    argv[0] === "mcp" &&
    process.env["DATABASES_DIST"] !== "1" &&
    Boolean(process.features.typescript) &&
    !sourceMcpPath.includes(`${sep}node_modules${sep}`) &&
    existsSync(sourceMcpPath)
  );
}

/**
 * Serves `src/mcp.ts` over stdio. The URL is built at runtime, so the bundler leaves `src` out.
 * @returns {Promise<void>} Once the server is connected.
 */
async function serveSource(): Promise<void> {
  const module: unknown = await import(sourceMcp.href);
  if (!isMcpModule(module)) throw new TypeError(`${sourceMcpPath} has no createMcpServer`);
  const { serveStdio } = await import("@agntn/tools/stdio");
  serveStdio(() => module.createMcpServer());
}

/**
 * Serves the bundled server, so `initialize` names it the way `src/` does.
 * @returns {Promise<void>} Once the server is listening.
 */
async function serveBundle(): Promise<void> {
  const [{ createMcpServer: create }, { serveStdio }] = await Promise.all([
    import("./mcp.ts"),
    import("@agntn/tools/stdio"),
  ]);
  serveStdio(() => create());
}

const argv = process.argv.slice(2);
if (servesSource(argv)) {
  await serveSource();
} else if (argv.length === 1 && argv[0] === "mcp") {
  await serveBundle();
} else {
  await runCli(
    {
      name: serverInfo.name,
      version: serverInfo.version,
      description: serverInfo.description,
      tools: databasesTools,
      groups: { migrations: { description: "Create, check and apply .sql migrations" } },
      mcp: true,
      // A refused or failed statement is an answer, so it prints as one line, not a stack.
      expected: (error) => error instanceof DatabasesError,
    },
    argv,
  );
}
