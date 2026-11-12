/** Provider registry, seeded from the built-in list on first use. Engine code loads on `create`. */

import { builtins } from "../providers/index.ts";
import { UnknownProviderError } from "./errors.ts";
import type { Provider, ProviderConstructor, ProviderEntry, ProviderMeta } from "./provider.ts";
import { parseReference, type DatabaseTarget } from "./reference.ts";

interface RegistryEntry {
  readonly meta: ProviderMeta;
  readonly load: () => Promise<ProviderConstructor>;
  loaded?: Promise<ProviderConstructor>;
}

let registry: Map<string, RegistryEntry> | undefined;

/**
 * The registry map, seeded with built-in metadata on the first call, so a listing never loads a
 * driver.
 *
 * @returns {Map<string, RegistryEntry>} Entries in registration order.
 */
function entries(): Map<string, RegistryEntry> {
  registry ??= new Map(
    builtins.map(({ load, ...meta }: ProviderEntry): [string, RegistryEntry] => [
      meta.key,
      { meta, load },
    ]),
  );
  return registry;
}

/**
 * Registers a provider from outside the package, or replaces a built-in under the same key.
 *
 * @param meta - Key, title and how references and read-only work.
 * @param providerClass - The class to instantiate.
 */
export function register(meta: ProviderMeta, providerClass: ProviderConstructor): void {
  const loaded = Promise.resolve(providerClass);
  entries().set(meta.key, { meta, load: () => loaded, loaded });
}

/**
 * Creates the provider for a resolved target. The first call for a built-in imports its module.
 *
 * @param target - What `parseReference` returned.
 * @returns {Promise<Provider>} The provider bound to that database.
 * @throws {UnknownProviderError} When no provider is registered under `target.provider`.
 */
export async function create(target: DatabaseTarget): Promise<Provider> {
  const entry = entries().get(target.provider);
  if (!entry) throw new UnknownProviderError(target.provider, providers());
  entry.loaded ??= entry.load().catch((error: unknown) => {
    entry.loaded = undefined;
    throw error;
  });
  const providerClass = await entry.loaded;
  return new providerClass(target);
}

/**
 * Opens a database by reference: a URL, a path, `d1:<database>` or a connection name.
 *
 * @example
 *   ```ts
 *   const shop = await open("postgres://reader@localhost/shop");
 *   const { rows } = await shop.query("SELECT id, total FROM orders WHERE total > $1", { params: [10] });
 *   ```
 *
 * @param reference - What names the database.
 * @returns {Promise<Provider>} The provider bound to it. Nothing connects until the first call.
 */
export function open(reference: string): Promise<Provider> {
  return create(parseReference(reference));
}

/**
 * Registered provider keys, in registration order.
 *
 * @returns {string[]} The keys.
 */
export function providers(): string[] {
  return [...entries().keys()];
}

/**
 * Describes every registered provider without loading any of them.
 *
 * @returns {ProviderMeta[]} Metadata in registration order.
 */
export function listProviders(): ProviderMeta[] {
  return [...entries().values()].map(({ meta }) => meta);
}
