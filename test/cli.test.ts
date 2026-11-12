import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, describe, expect, it } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };
import { sqliteFixture } from "./helpers.ts";

const switches = new Set([
  "CI",
  "FORCE_COLOR",
  "NO_COLOR",
  "NODE_DISABLE_COLORS",
  "DATABASES_DIST",
  "TEST",
]);
const isolated = mkdtempSync(join(tmpdir(), "databases-home-"));
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !switches.has(key) && !key.startsWith("DATABASES_") && !key.startsWith("CLOUDFLARE_"),
    ),
  ),
  TERM: "xterm-256color",
  HOME: isolated,
  XDG_CONFIG_HOME: isolated,
};
const fixture = sqliteFixture();

afterAll(() => {
  fixture.dispose();
});

function run(...args: readonly string[]) {
  return runWith({}, undefined, ...args);
}

function runWith(
  extra: Readonly<Record<string, string>>,
  input: string | undefined,
  ...args: readonly string[]
) {
  const { status, stderr, stdout } = spawnSync(process.execPath, ["src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...env, ...extra },
    ...(input === undefined ? {} : { input }),
  });
  return { code: status, stderr, stdout };
}

describe("databases CLI", () => {
  it("prints the usage without colors into a pipe", () => {
    const help = run("--help");
    const usage = run("query", "--help");
    const unknown = run("nope");

    expect(help.stdout).toContain("USAGE databases <command> [OPTIONS]");
    for (const command of ["providers", "schema", "sample", "query", "explain", "execute", "mcp"]) {
      expect(help.stdout).toMatch(new RegExp(`^ {2}${command} `, "mu"));
    }
    expect(usage.stdout).toContain("DATABASE");
    expect(usage.stdout).toContain("--limit");
    expect(unknown).toMatchObject({
      code: 1,
      stderr: 'Unknown command "nope"\nRun databases --help for the commands\n',
    });
    for (const output of [help, usage, unknown]) {
      expect(output.stdout + output.stderr).not.toContain("\u001B");
    }
    expect(run("--version")).toMatchObject({ code: 0, stdout: `${pkg.version}\n` });
  });

  it("queries a file and prints JSON with --json", () => {
    const text = run("query", fixture.path, "SELECT name FROM owners ORDER BY id", "-n", "1");
    const json = run("query", fixture.path, "SELECT name FROM owners ORDER BY id", "--json");

    expect(text).toMatchObject({ code: 0, stderr: "" });
    expect(text.stdout).toBe(
      `${fixture.path} (sqlite): 1 row, more not read (limit 1)\ncolumns: ["name"]\ntypes: ["text"]\n["Ada"]\nMore rows exist. Narrow the query, aggregate it, or raise limit (up to 1000).\n`,
    );
    expect(JSON.parse(json.stdout)).toMatchObject({
      provider: "sqlite",
      rows: [["Ada"], ["Linus"]],
      more: false,
    });
  });

  it("reads the statement from stdin given as -", () => {
    const piped = runWith({}, "SELECT count(*) FROM items", "query", fixture.path, "-");

    expect(piped).toMatchObject({ code: 0 });
    expect(piped.stdout).toContain("[3]");
  });

  it("refuses a write in one line on stderr", () => {
    expect(run("query", fixture.path, "DELETE FROM items")).toMatchObject({
      code: 1,
      stdout: "",
      stderr:
        "Refused: the statement writes, changes a setting, attaches a file or calls a function outside the database. Only reads run here; use execute for a write [refused]\n",
    });
    expect(run("execute", fixture.path, "DELETE FROM items")).toMatchObject({
      code: 1,
      stdout: "",
    });
    expect(run("schema", "no such thing")).toMatchObject({ code: 1 });
  });

  it("finds a named connection in the environment", () => {
    const listed = runWith(
      { DATABASES_SHOP_URL: `sqlite:${fixture.path}` },
      undefined,
      "providers",
    );
    const schema = runWith(
      { DATABASES_SHOP_URL: `sqlite:${fixture.path}` },
      undefined,
      "schema",
      "shop",
      "owners",
    );

    expect(listed.stdout).toContain(`shop  sqlite  ${fixture.path}`);
    expect(schema.stdout).toContain("owners (table), 2 columns:");
  });
});

const root = fileURLToPath(new URL("..", import.meta.url));

/* Writes the module URLs the child loaded to `file` on exit; stderr cuts them at about 146 KB. */
function recordLoads(file: string) {
  return `data:text/javascript,${encodeURIComponent(`
  import { writeFileSync } from "node:fs";
  import { registerHooks } from "node:module";
  const loaded = [];
  registerHooks({
    load(url, context, nextLoad) {
      loaded.push(url);
      return nextLoad(url, context);
    },
  });
  process.on("exit", () => writeFileSync(${JSON.stringify(file)}, JSON.stringify(loaded)));
`)}`;
}

const initialize = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "databases-test", version: "1.0.0" },
  },
})}\n`;

/**
 * Runs `mcp` from a built bin, answers one initialize request and tells where the server came
 * from. stdin closes after the request, so the server exits on its own.
 */
function serve(base: string, extraEnv: Readonly<Record<string, string>> = {}) {
  const record = mkdtempSync(join(tmpdir(), "databases-loaded-"));
  const file = join(record, "loaded.json");
  let child;
  let loaded: unknown = [];
  try {
    child = spawnSync(
      process.execPath,
      ["--import", recordLoads(file), join(base, "dist/cli.mjs"), "mcp"],
      {
        encoding: "utf8",
        env: { ...env, ...extraEnv },
        input: initialize,
        timeout: 20_000,
      },
    );
    if (existsSync(file)) loaded = JSON.parse(readFileSync(file, "utf8"));
  } finally {
    rmSync(record, { recursive: true, force: true });
  }
  const { status, stderr, stdout } = child;
  const urls = Array.isArray(loaded) ? loaded.filter((url) => typeof url === "string") : [];
  const source = urls.includes(pathToFileURL(join(base, "src/mcp.ts")).href);
  const bundle = urls.includes(pathToFileURL(join(base, "dist/mcp.mjs")).href);
  let from: "bundle" | "source" | "unknown" = "unknown";
  if (source) from = "source";
  else if (bundle) from = "bundle";
  const name = /"serverInfo":\{"name":"([^"]+)"/.exec(stdout)?.[1];
  return { code: status, from, name, stderr };
}

function served(from: "bundle" | "source") {
  return { code: 0, from, name: "databases" };
}

const refused = {
  isError: true,
  content: [
    { type: "text", text: "src/ changed under this server, restart it to load the new code" },
  ],
};

/** Starts `mcp` from the built bin of a checkout copy and connects a client to it. */
async function checkoutServer(
  patch: Readonly<Record<string, (source: string) => string>> = {},
  reuse?: string,
) {
  const checkout = reuse ?? mkdtempSync(join(tmpdir(), "databases-cli-"));
  if (reuse === undefined) {
    for (const entry of ["dist", "src", "package.json"]) {
      cpSync(join(root, entry), join(checkout, entry), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(checkout, "node_modules"), "dir");
  }
  for (const [file, rewrite] of Object.entries(patch)) {
    const path = join(checkout, "src", file);
    writeFileSync(path, rewrite(readFileSync(path, "utf8")));
  }
  const client = new Client({ name: "databases-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(checkout, "dist/cli.mjs"), "mcp"],
      env,
      stderr: "ignore",
    }),
  );
  return { checkout, client };
}

describe.skipIf(!existsSync(join(root, "dist/cli.mjs")))("databases mcp from the built bin", () => {
  it("serves the live source inside a checkout", () => {
    expect(serve(root)).toMatchObject(served("source"));
  });

  it("keeps the bundle under DATABASES_DIST=1 and without type stripping", () => {
    expect(serve(root, { DATABASES_DIST: "1" })).toMatchObject(served("bundle"));
    expect(serve(root, { NODE_OPTIONS: "--no-strip-types" })).toMatchObject({
      code: 0,
      name: "databases",
    });
  });

  it("keeps the bundle when the package sits under node_modules", () => {
    const cache = join(root, "node_modules/.cache");
    mkdirSync(cache, { recursive: true });
    const nested = mkdtempSync(join(cache, "databases-cli-"));
    try {
      for (const entry of ["dist", "src", "package.json"]) {
        cpSync(join(root, entry), join(nested, entry), { recursive: true });
      }
      expect(serve(nested)).toMatchObject(served("bundle"));
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it("keeps the bundle in a package that ships no src, and its SQLite runner works", async () => {
    const packaged = mkdtempSync(join(tmpdir(), "databases-cli-"));
    try {
      for (const entry of ["dist", "extensions", "package.json"]) {
        cpSync(join(root, entry), join(packaged, entry), { recursive: true });
      }
      symlinkSync(join(root, "node_modules"), join(packaged, "node_modules"), "dir");
      expect(serve(packaged)).toMatchObject(served("bundle"));

      const query = spawnSync(
        process.execPath,
        [join(packaged, "dist/cli.mjs"), "query", fixture.path, "SELECT 1 AS one"],
        {
          encoding: "utf8",
          env,
        },
      );
      expect(query.stdout).toContain('columns: ["one"]');
    } finally {
      rmSync(packaged, { recursive: true, force: true });
    }
  });

  it("refuses a call after a pull instead of mixing old and new modules", async () => {
    const { checkout, client } = await checkoutServer();
    try {
      await client.listTools();
      const limits = join(checkout, "src/core/limits.ts");
      const operations = join(checkout, "src/tool-operations.ts");
      writeFileSync(limits, `${readFileSync(limits, "utf8")}export const ADDED = 1;\n`);
      writeFileSync(
        operations,
        readFileSync(operations, "utf8").replace(
          'import { MAX_ROWS } from "./core/limits.ts";',
          'import { MAX_ROWS, ADDED } from "./core/limits.ts";',
        ),
      );

      for (const [name, args] of [
        ["databases_providers", {}],
        ["databases_query", { databse: "x" }],
        ["databases_added", {}],
      ] as const) {
        expect(await client.callTool({ name, arguments: args })).toMatchObject(refused);
      }
    } finally {
      await client.close();
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("refuses before the tool runs, not only after it answers", async () => {
    const { checkout, client } = await checkoutServer({
      "tool-operations.ts": (operations) =>
        `import { writeFileSync } from "node:fs";\n${operations.replace(
          "  const providers = listRegistered();",
          `  writeFileSync(new URL("../ran", import.meta.url), "");
  const providers = listRegistered();`,
        )}`,
    });
    try {
      await client.listTools();
      writeFileSync(join(checkout, "src/pulled.ts"), "export {};\n");

      expect(await client.callTool({ name: "databases_providers", arguments: {} })).toMatchObject(
        refused,
      );
      expect(existsSync(join(checkout, "ran"))).toBe(false);
    } finally {
      await client.close();
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("refuses whatever a call returns once a pull lands mid-call", async () => {
    const { checkout, client } = await checkoutServer({
      "tool-operations.ts": (operations) =>
        `import { writeFileSync } from "node:fs";\n${operations.replace(
          "  const limit = limitOf(input.limit);\n  const { provider, value } = await withDatabase(input.database, (db) =>\n    db.query(",
          `  writeFileSync(new URL(\`./pulled-\${input.database.length}.ts\`, import.meta.url), "export {};\\n");
  if (input.database === "boom") throw new Error("boom");
  const limit = limitOf(input.limit);
  const { provider, value } = await withDatabase(input.database, (db) =>
    db.query(`,
        )}`,
    });
    try {
      expect(
        await client.callTool({
          name: "databases_query",
          arguments: { database: fixture.path, sql: "SELECT 1" },
        }),
      ).toMatchObject(refused);

      const fresh = await checkoutServer({}, checkout);
      try {
        expect(
          await fresh.client.callTool({
            name: "databases_query",
            arguments: { database: "boom", sql: "SELECT 1" },
          }),
        ).toMatchObject(refused);
      } finally {
        await fresh.client.close();
      }
    } finally {
      await client.close();
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
