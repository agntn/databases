/**
 * Why a database call failed. Branch on this, not on the message, which may be reworded.
 *
 * - `config`: the database reference names nothing usable.
 * - `auth`: the engine or the API refused the credentials.
 * - `connection`: the database could not be reached.
 * - `refused`: the statement would write, or is more than one statement, and was never sent.
 * - `query`: the engine rejected or failed the statement.
 * - `timeout`: the statement ran past its deadline and was cancelled.
 * - `unsupported`: the provider has no such operation.
 */
export type DatabasesErrorCode =
  | "config"
  | "auth"
  | "connection"
  | "refused"
  | "query"
  | "timeout"
  | "unsupported";

export interface DatabasesErrorOptions extends ErrorOptions {
  /** What went wrong. */
  readonly code: DatabasesErrorCode;
  /** The provider the call went to, when one was chosen. */
  readonly provider?: string;
  /** The engine's own error code, such as Postgres SQLSTATE `42P01`. */
  readonly engineCode?: string;
}

/**
 * A database call failed. The message never carries a password or a token: references are
 * redacted before they reach it, so it is safe to hand to a model.
 */
export class DatabasesError extends Error {
  override readonly name: string = "DatabasesError";
  readonly code: DatabasesErrorCode;
  readonly provider: string | undefined;
  readonly engineCode: string | undefined;

  /**
   * @param message - What failed and, where it helps, what to do next.
   * @param options - The code, the provider and the underlying failure.
   */
  constructor(message: string, options: Readonly<DatabasesErrorOptions>) {
    super(message, options);
    this.code = options.code;
    this.provider = options.provider;
    this.engineCode = options.engineCode;
  }
}

/** The name passed to `create` or `register` lookups matches no provider. */
export class UnknownProviderError extends DatabasesError {
  override readonly name: string = "UnknownProviderError";

  /**
   * @param provider - The key that was asked for.
   * @param known - Every registered key.
   */
  constructor(provider: string, known: readonly string[]) {
    super(`Unknown provider ${JSON.stringify(provider)}. Known: ${known.join(", ")}`, {
      code: "config",
    });
  }
}
