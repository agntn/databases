/**
 * Bounds shared by the library and the tool schemas. This module imports nothing, so the schemas
 * can read it without loading a driver.
 */

/** Rows a query returns when the caller names no limit. */
export const DEFAULT_ROWS = 50;

/** Most rows one call returns; a larger result needs a narrower query. */
export const MAX_ROWS = 1000;

/** Rows `sample` reads when the caller names no limit. */
export const DEFAULT_SAMPLE_ROWS = 10;

/** Longest SQL text a call accepts, in UTF-16 code units. */
export const MAX_SQL_LENGTH = 100_000;

/** Most bind parameters one statement takes. */
export const MAX_PARAMS = 100;

/** Longest text a cell keeps before it is cut. */
export const MAX_CELL_CHARS = 500;

/** Bytes of a blob shown as hex; the size is always given. */
export const MAX_BLOB_BYTES = 32;

/** Rough ceiling on the rows of one answer, in characters of their JSON. */
export const MAX_RESULT_CHARS = 100_000;

/** Wall time one statement gets before it is cancelled. */
export const STATEMENT_TIMEOUT_MS = 30_000;

/** Wall time a connection gets to open. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Longest database reference or table name accepted. */
export const MAX_NAME_LENGTH = 2048;
