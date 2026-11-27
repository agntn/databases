/**
 * Carries whole SQLite values from the child process as JSON, which has no bigint, no bytes, no
 * infinity and no negative zero. Imports no `node:sqlite`, so the parent side loads anywhere.
 */

import type { SqliteValue } from "./types.ts";

/** A value JSON can't hold as itself. */
export type WireTag =
  | { readonly $bigint: string }
  | { readonly $bytes: string }
  | { readonly $real: "Infinity" | "-Infinity" | "-0" };

export type WireValue = string | number | null | WireTag;

/**
 * One value for the wire.
 *
 * @param value - What the read returned.
 * @returns {WireValue} The same value, tagged where JSON would change it.
 */
export function toWire(value: SqliteValue): WireValue {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: value.toBase64() };
  if (typeof value !== "number" || (Number.isFinite(value) && !Object.is(value, -0))) return value;
  return { $real: Object.is(value, -0) ? "-0" : value > 0 ? "Infinity" : "-Infinity" };
}

/**
 * One value back from the wire.
 *
 * @param value - What the child wrote.
 * @returns {SqliteValue} The value as the read returned it.
 */
export function fromWire(value: WireValue): SqliteValue {
  if (value === null || typeof value !== "object") return value;
  if ("$bigint" in value) return BigInt(value.$bigint);
  if ("$bytes" in value) return Uint8Array.fromBase64(value.$bytes);
  return Number(value.$real);
}
