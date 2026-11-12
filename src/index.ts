export { version } from "./version.ts";
export { DatabasesError, UnknownProviderError } from "./core/errors.ts";
export type { DatabasesErrorCode, DatabasesErrorOptions } from "./core/errors.ts";
export { create, listProviders, open, providers, register } from "./core/registry.ts";
export { Provider } from "./core/provider.ts";
export type { ProviderConstructor, ProviderMeta } from "./core/provider.ts";
export {
  connectionVariable,
  listConnections,
  parseReference,
  redactUrl,
} from "./core/reference.ts";
export type { DatabaseTarget, NamedConnection } from "./core/reference.ts";
export {
  DEFAULT_ROWS,
  DEFAULT_SAMPLE_ROWS,
  MAX_PARAMS,
  MAX_ROWS,
  MAX_SQL_LENGTH,
  STATEMENT_TIMEOUT_MS,
} from "./core/limits.ts";
export type {
  BlobCell,
  Cell,
  Column,
  ColumnInfo,
  ExecuteOptions,
  ExecuteResult,
  ExplainOptions,
  ForeignKeyInfo,
  IndexInfo,
  Param,
  PlanResult,
  QueryOptions,
  QueryResult,
  RelationKind,
  SampleOptions,
  SchemaOptions,
  TableDetail,
  TableSummary,
} from "./core/types.ts";
