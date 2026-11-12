import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMcpServer } from "../src/mcp.ts";
import { readDirect, sqliteFixture } from "./helpers.ts";

const openConnections: Array<{ close(): Promise<void> }> = [];
const fixture = sqliteFixture();

async function connectTestClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "databases-test", version: "1.0.0" });
  openConnections.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(response: Awaited<ReturnType<Client["callTool"]>>): string {
  const [part] = response.content as Array<{ text: string }>;
  return part?.text ?? "";
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(openConnections.splice(0).map((connection) => connection.close()));
});

afterAll(() => {
  fixture.dispose();
});

describe("databases MCP server", () => {
  it("lists every tool with a title and the right hints", async () => {
    const client = await connectTestClient();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "databases_providers",
      "databases_schema_get",
      "databases_table_sample",
      "databases_query",
      "databases_explain",
      "databases_execute",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.title).toBe(tool.title);
      expect(tool.inputSchema.type).toBe("object");
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("databases_query")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get("databases_execute")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.get("databases_query")?.inputSchema).toMatchObject({
      required: ["database", "sql"],
      additionalProperties: false,
    });
  });

  it("names configured connections without their passwords", async () => {
    vi.stubEnv("DATABASES_SHOP_URL", "postgres://reader:hunter22@db.internal/shop");
    const client = await connectTestClient();

    const response = await client.callTool({ name: "databases_providers", arguments: {} });

    expect(text(response)).toContain("shop  postgres  postgres://reader:***@db.internal/shop");
    expect(text(response)).toContain("Writes: off");
    expect(JSON.stringify(response)).not.toContain("hunter22");
  });

  it("answers a query with escaped rows a model can't mistake for others", async () => {
    vi.stubEnv("DATABASES_SHOP_URL", `sqlite:${fixture.path}`);
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "databases_query",
      arguments: { database: "shop", sql: "SELECT id, label FROM items ORDER BY id", limit: 2 },
    });
    const third = await client.callTool({
      name: "databases_query",
      arguments: { database: "shop", sql: "SELECT label FROM items WHERE id = ?", params: [3] },
    });

    expect(response.isError).not.toBe(true);
    expect(text(response)).toBe(
      [
        `${fixture.path} (sqlite): 2 rows, more not read (limit 2)`,
        'columns: ["id","label"]',
        'types: ["integer","text"]',
        '[1,"a"]',
        '[2,"b"]',
        "More rows exist. Narrow the query, aggregate it, or raise limit (up to 1000).",
      ].join("\n"),
    );
    expect(text(third).split("\n")).toHaveLength(4);
    expect(text(third)).toContain('["line\\nbreak\\u202eend"]');
    expect(text(third)).not.toMatch(/[\u202E\u2028\u2029]/u);
  });

  it("refuses a write as a tool error and leaves the file alone", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "databases_query",
      arguments: { database: fixture.path, sql: "DELETE FROM items" },
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toMatch(/Refused: the statement writes.*\[refused\]$/u);
    expect(readDirect(fixture.path, "SELECT count(*) AS n FROM items")).toEqual([{ n: 3 }]);
  });

  it("keeps databases_execute off until the server allows writes", async () => {
    const writable = sqliteFixture();
    try {
      const client = await connectTestClient();
      const call = {
        name: "databases_execute",
        arguments: { database: writable.path, sql: "DELETE FROM items" },
      };

      const off = await client.callTool(call);
      expect(off.isError).toBe(true);
      expect(text(off)).toContain("DATABASES_WRITE=1");
      expect(readDirect(writable.path, "SELECT count(*) AS n FROM items")).toEqual([{ n: 3 }]);

      vi.stubEnv("DATABASES_WRITE", "1");
      const on = await client.callTool(call);
      expect(text(on)).toBe(`${writable.path} (sqlite): 3 rows changed`);
      expect(readDirect(writable.path, "SELECT count(*) AS n FROM items")).toEqual([{ n: 0 }]);
    } finally {
      writable.dispose();
    }
  });

  it("describes the schema and samples a table", async () => {
    const client = await connectTestClient();

    const tables = await client.callTool({
      name: "databases_schema_get",
      arguments: { database: fixture.path },
    });
    const table = await client.callTool({
      name: "databases_schema_get",
      arguments: { database: fixture.path, table: "items" },
    });
    const sample = await client.callTool({
      name: "databases_table_sample",
      arguments: { database: fixture.path, table: "owners" },
    });
    const plan = await client.callTool({
      name: "databases_explain",
      arguments: { database: fixture.path, sql: "SELECT * FROM owners" },
    });

    expect(text(tables)).toContain("items  table\nowned  view\nowners  table");
    expect(text(table)).toContain("  (owner_id) -> owners (id)");
    expect(text(sample)).toContain('[2,"Linus"]');
    expect(text(plan)).toMatch(/SCAN owners/u);
  });

  it("rejects an unknown key, a bad limit and a prototype name", async () => {
    const client = await connectTestClient();

    const unknown = await client.callTool({
      name: "databases_query",
      arguments: { database: fixture.path, sql: "SELECT 1", rows: 5 },
    });
    const limit = await client.callTool({
      name: "databases_query",
      arguments: { database: fixture.path, sql: "SELECT 1", limit: 5000 },
    });
    const prototype = await client.callTool({ name: "toString", arguments: {} });

    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('unknown property "rows"');
    expect(limit.isError).toBe(true);
    expect(prototype.isError).toBe(true);
  });
});
