import oxfmt from "@agntn/ox/oxfmt";
import oxlint from "@agntn/ox/oxlint";
import { defineConfig } from "vite-plus";

export default defineConfig({
  /** The site in docs/ is formatted by its own rules. */
  fmt: { ...oxfmt, ignorePatterns: ["dist", "docs"] },
  lint: {
    ...oxlint,
    rules: {
      ...oxlint.rules,
      "typescript/prefer-readonly-parameter-types": [
        "error",
        {
          allow: [
            /* Signals get listened to, errors and patterns read, never written. */
            { from: "lib", name: ["AbortSignal", "Error", "RegExp", "Response"] },
            /* TypedArrays have no readonly form in the TS lib; bytes are only read here. */
            { from: "lib", name: ["Uint8Array"] },
            /* A budget exists to be marked; a provider and a child result are only read. */
            { from: "file", name: ["CellBudget", "ChildResult", "Provider"] },
            /* The SQLite connection and statement are handles; the guard installs a callback. */
            { from: "package", name: ["DatabaseSync", "StatementSync"], package: "node:sqlite" },
            {
              from: "package",
              name: ["ExtensionAPI"],
              package: "@earendil-works/pi-coding-agent",
            },
            { from: "package", name: ["ExtensionAPI"], package: "@oh-my-pi/pi-coding-agent" },
          ],
          ignoreInferredTypes: true,
        },
      ],
    },
    overrides: [
      {
        /** Tests build mutable fixtures and need no API docs. */
        files: ["test/**/*.ts"],
        rules: {
          "jsdoc/require-param": "off",
          "jsdoc/require-returns": "off",
          "typescript/prefer-readonly-parameter-types": "off",
        },
      },
    ],
    ignorePatterns: ["dist", "docs"],
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
