/** Vercel AI SDK tool surface over the shared databases tool definitions. */

import { toAiTools, type AiTools } from "@agntn/tools/ai";
import { databasesTools } from "./tools.ts";

/** Every databases tool, keyed by the name MCP, Pi and OMP use for it. */
export const databasesAiTools: AiTools<typeof databasesTools> = toAiTools(databasesTools);
