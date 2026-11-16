/**
 * Every in-process test starts with no named connections and no Cloudflare
 * credentials, and with a home the cf CLI has never seen. Set directly, not through `vi.stubEnv`,
 * so `vi.unstubAllEnvs()` comes back here instead of to the developer's real environment.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "databases-test-"));

for (const key of Object.keys(process.env)) {
  if (key.startsWith("DATABASES_") && key !== "DATABASES_TEST_POSTGRES_URL")
    delete process.env[key];
}
for (const key of [
  "CLOUDFLARE_API_TOKEN",
  "AGNTN_CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ACCOUNT_ID",
]) {
  delete process.env[key];
}
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;
