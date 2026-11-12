import { version } from "../../../package.json";

/** The Docus page tools as `databases`, with a pitch and an icon so the card is more than a name. */
export default defineMcpHandler({
  name: "databases",
  version,
  description:
    "The docs for @agntn/databases, which reads the schema, rows and query plans of SQLite, Postgres and Cloudflare D1 databases with writes refused by the engine. List the pages or read one. To query a database, run the package's own server: npx -y @agntn/databases mcp.",
  /** Absolute URLs, so the card loses its icon without a word once either file leaves public/. */
  icons: [
    { src: "https://databases.agntn.dev/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    { src: "https://databases.agntn.dev/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
  ],
});
