/** Turns driver values into JSON-safe cells and keeps an answer small. */

import { MAX_BLOB_BYTES, MAX_CELL_CHARS, MAX_RESULT_CHARS } from "./limits.ts";
import type { BlobCell, Cell } from "./types.ts";

/** Collects whether anything was shortened while cells were built. */
export interface CellBudget {
  cut: boolean;
}

/** Items of an array or keys of an object a nested value keeps. */
const MAX_ITEMS = 100;

/** Nesting a JSON value may reach before it is replaced by a note. */
const MAX_DEPTH = 8;

/**
 * One driver value as a cell. Bigints become strings so no digit is lost, bytes become a hex
 * prefix with the full size, dates an ISO string, and text longer than `MAX_CELL_CHARS` is cut.
 *
 * @param value - What the driver returned.
 * @param budget - Marked when the value had to be shortened.
 * @param depth - Nesting of a JSON value, so a cyclic or deep structure stops.
 * @returns {Cell} The cell.
 */
export function toCell(value: unknown, budget: CellBudget, depth = 0): Cell {
  if (typeof value !== "object" || value === null) return toPrimitive(value, budget);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Uint8Array) return toBlob(value, budget);
  if (depth >= MAX_DEPTH) {
    budget.cut = true;
    return "[nested too deep]";
  }
  return Array.isArray(value)
    ? toList(value, budget, depth)
    : toRecord(value as Readonly<Record<string, unknown>>, budget, depth);
}

/**
 * A value that isn't an object.
 *
 * @param value - String, number, boolean, bigint, null or undefined.
 * @param budget - Marked when text was cut.
 * @returns {Cell} The cell.
 */
function toPrimitive(value: unknown, budget: CellBudget): Cell {
  switch (typeof value) {
    case "string": {
      return cutText(value, budget);
    }
    case "number": {
      return Number.isFinite(value) ? value : String(value);
    }
    case "boolean": {
      return value;
    }
    case "bigint": {
      return exactInteger(value);
    }
    default: {
      return value === null || value === undefined ? null : `[${typeof value}]`;
    }
  }
}

/**
 * A bigint as a number while that stays exact, as its digits past that.
 *
 * @param value - The integer.
 * @returns {number | string} The cell.
 */
function exactInteger(value: bigint): number | string {
  const safe = value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER;
  return safe ? Number(value) : value.toString();
}

/**
 * An array, its first `MAX_ITEMS` items kept.
 *
 * @param value - The array.
 * @param budget - Marked when items were left out.
 * @param depth - Nesting so far.
 * @returns {Cell[]} The items.
 */
function toList(value: readonly unknown[], budget: CellBudget, depth: number): Cell[] {
  if (value.length > MAX_ITEMS) budget.cut = true;
  return value.slice(0, MAX_ITEMS).map((item) => toCell(item, budget, depth + 1));
}

/**
 * An object, its first `MAX_ITEMS` own keys kept.
 *
 * @param value - The object.
 * @param budget - Marked when keys were left out.
 * @param depth - Nesting so far.
 * @returns {Record<string, Cell>} The entries.
 */
function toRecord(
  value: Readonly<Record<string, unknown>>,
  budget: CellBudget,
  depth: number,
): Record<string, Cell> {
  const entries: [string, Cell][] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (entries.length >= MAX_ITEMS) {
      budget.cut = true;
      break;
    }
    entries.push([key, toCell(value[key], budget, depth + 1)]);
  }
  return Object.fromEntries(entries);
}

/**
 * Bytes as a hex prefix.
 *
 * @param bytes - The blob.
 * @param budget - Marked when the hex was cut.
 * @returns {BlobCell} The cell.
 */
export function toBlob(bytes: Uint8Array, budget: CellBudget): BlobCell {
  let hex = "";
  for (const byte of bytes.subarray(0, MAX_BLOB_BYTES)) hex += byte.toString(16).padStart(2, "0");
  if (bytes.length <= MAX_BLOB_BYTES) return { $blob: hex, bytes: bytes.length };
  budget.cut = true;
  return { $blob: hex, bytes: bytes.length, cut: true };
}

/**
 * Text cut to `MAX_CELL_CHARS` without splitting a surrogate pair.
 *
 * @param text - The value.
 * @param budget - Marked when the text was cut.
 * @returns {string} The text, or its start with a count of what was left out.
 */
function cutText(text: string, budget: CellBudget): string {
  if (text.length <= MAX_CELL_CHARS) return text;
  budget.cut = true;
  /* A code point past U+FFFF at the last kept index starts a pair the cut would split. */
  const end =
    (text.codePointAt(MAX_CELL_CHARS - 1) ?? 0) > 0xff_ff ? MAX_CELL_CHARS - 1 : MAX_CELL_CHARS;
  return `${text.slice(0, end)}… [+${text.length - end} chars]`;
}

/**
 * Keeps rows while their JSON fits `MAX_RESULT_CHARS`, at least one.
 *
 * @param rows - Rows built so far.
 * @param budget - Marked when rows were left out.
 * @returns {Cell[][]} The rows that fit.
 */
export function fitRows(rows: readonly (readonly Cell[])[], budget: CellBudget): Cell[][] {
  const kept: Cell[][] = [];
  let size = 0;
  for (const row of rows) {
    size += JSON.stringify(row).length + 1;
    if (kept.length > 0 && size > MAX_RESULT_CHARS) {
      budget.cut = true;
      break;
    }
    kept.push([...row]);
  }
  return kept;
}
