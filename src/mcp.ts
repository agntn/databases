import { createMcpServer as createToolServer } from "@agntn/tools/mcp";
import type { Server } from "@modelcontextprotocol/server";
import { serverInfo } from "./server-info.ts";
import { sourceChangeCheck } from "./source-change.ts";
import { databasesTools } from "./tools.ts";

const restart = "src/ changed under this server, restart it to load the new code";

/** The baseline is the process start, so a pull during startup counts. */
const changed = import.meta.url.endsWith(".ts")
  ? sourceChangeCheck(import.meta.dirname, performance.timeOrigin)
  : undefined;

/**
 * Creates an unconnected MCP server exposing the databases tools. Run from `src/`, it answers with
 * a restart line before and after every call once that tree changed, a success included.
 *
 * @returns {Server} Unconnected MCP server.
 */
export function createMcpServer(): Server {
  if (!changed) return createToolServer(serverInfo, databasesTools);
  return createToolServer(serverInfo, databasesTools, {
    refuse: () => (changed() ? restart : undefined),
  });
}
