import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      /** One bundle, so every entry shares one provider registry with the root. */
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/cli.ts",
        "./src/ai.ts",
        "./src/mcp.ts",
        "./src/tools.ts",
        /** Started as its own process by the SQLite provider; it finds it beside the chunks. */
        "./src/sqlite-child.ts",
      ],
      /** No maps: the JS ones miss every throw, the type ones point at a src/ we don't ship. */
      dts: { sourcemap: false },
    },
  ],
});
