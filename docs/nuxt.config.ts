import { resolve } from "node:path";
import { databasesTheme } from "./shiki-theme";

export default defineNuxtConfig({
  extends: ["docus"],
  /** The library runs at build time only, in scripts/samples.mjs. The browser gets its answers as JSON. */
  vite: {
    build: { target: "es2024" },
  },
  devtools: { enabled: false },
  telemetry: false,
  site: {
    url: "https://databases.agntn.dev",
    name: "@agntn/databases",
  },
  /** Docus lists `content/` only and leaves app routes out, so the Vue pages come from here. */
  sitemap: {
    sources: ["/api/__sitemap__/pages"],
  },
  /** Spelled out, or agent discovery lumps the guide and the providers into one `Docs` list. */
  llms: {
    title: "@agntn/databases",
    description:
      "Schema, read-only queries and query plans for SQLite, Postgres and Cloudflare D1, with writes refused by the engine itself.",
    sections: [
      {
        title: "MCP",
        description: "The pages of this site over Streamable HTTP, for an agent that reads docs.",
        links: [
          {
            title: "MCP endpoint",
            href: "https://databases.agntn.dev/mcp",
            description:
              "Add it to any MCP client as an HTTP server, for example `claude mcp add --transport http databases-docs https://databases.agntn.dev/mcp`. It serves these pages. Queries go through the package's own server, `npx -y @agntn/databases mcp`.",
          },
        ],
      },
      {
        title: "Guide",
        contentCollection: "docs",
        contentFilters: [{ field: "path", operator: "LIKE", value: "/guide%" }],
      },
      {
        title: "Engines",
        contentCollection: "docs",
        contentFilters: [{ field: "path", operator: "LIKE", value: "/providers%" }],
      },
    ],
  },
  /** Docus pages define their own OG images; the alt text is the one thing they leave unset. */
  ogImage: {
    defaults: {
      alt: "@agntn/databases: schema, rows and plans from SQLite, Postgres and D1, writes refused by the engine",
    },
  },
  icon: {
    clientBundle: {
      icons: [
        "lucide:arrow-down",
        "lucide:arrow-left",
        "lucide:arrow-right",
        "lucide:arrow-up",
        "lucide:arrow-up-right",
        "lucide:book-open",
        "lucide:bot",
        "lucide:check",
        "lucide:chevron-down",
        "lucide:chevron-left",
        "lucide:chevron-right",
        "lucide:chevrons-up-down",
        "lucide:circle-alert",
        "lucide:circle-check",
        "lucide:circle-x",
        "lucide:copy",
        "lucide:database",
        "lucide:external-link",
        "lucide:info",
        "lucide:library",
        "lucide:link",
        "lucide:list-ordered",
        "lucide:key-round",
        "lucide:route",
        "lucide:shield-check",
        "lucide:shield-x",
        "lucide:square-terminal",
        "lucide:table",
        "lucide:triangle-alert",
        "lucide:x",
        "lucide:zap",
        "simple-icons:cloudflare",
        "simple-icons:github",
        "simple-icons:npm",
        "simple-icons:postgresql",
        "simple-icons:sqlite",
        "vscode-icons:file-type-js",
        "vscode-icons:file-type-json",
        "vscode-icons:file-type-shell",
        "vscode-icons:file-type-typescript",
      ],
    },
  },
  colorMode: {
    preference: "dark",
  },
  app: {
    head: {
      /** favicon.svg is the source; the PNGs and favicon.ico are cut from it with ImageMagick. */
      link: [
        { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
        { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
        { rel: "manifest", href: "/site.webmanifest" },
      ],
      meta: [
        { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#0b0d10" },
        { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#eef1f4" },
        { name: "apple-mobile-web-app-title", content: "databases" },
        { name: "author", content: "oritwoen" },
        { property: "og:locale", content: "en_US" },
      ],
    },
  },
  nitro: {
    preset: "cloudflare_module",
    /**
     * One MCP SDK in the worker. The Docus toolkit builds its server from one copy and `agents` checks it
     * with `instanceof` against another. pnpm can split them by the peers each copy resolves.
     */
    alias: {
      "@modelcontextprotocol/sdk": resolve(import.meta.dirname, "node_modules/@modelcontextprotocol/sdk/dist/esm"),
    },
    compatibilityDate: "2026-09-03",
    esbuild: { options: { target: "es2024" } },
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
    },
  },
  /** Nuxt's own prerender option. The same keys under `nitro.prerender` are deprecated. */
  prerender: {
    crawlLinks: true,
    routes: ["/", "/sitemap.xml", "/robots.txt", "/llms.txt", "/llms-full.txt"],
  },
  compatibilityDate: "2026-09-03",
  /** Fonts live in public/fonts and app/assets/fonts.css, where nuxt-og-image reads them from. */
  css: ["~/assets/fonts.css"],
  fonts: {
    families: [
      { name: "Figtree", provider: "local", weights: [400, 500] },
      { name: "Fira Code", provider: "local", weights: [400, 500] },
    ],
  },
  content: {
    database: {
      type: "d1",
      bindingName: "DB",
    },
    build: {
      markdown: {
        highlight: {
          theme: {
            default: databasesTheme,
            light: databasesTheme,
            dark: databasesTheme,
          },
        },
      },
    },
  },
});
