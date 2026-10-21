import { DrizzleQueryError } from "drizzle-orm/errors";

export { DrizzleQueryError };

// Postgres error codes callers branch on. Drizzle wraps driver errors in
// DrizzleQueryError, so the code may sit on the error or on its cause.
export const pgErrorCodes = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
} as const;

export const getPgErrorCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Object; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

export const isUniqueViolation = (error: unknown) =>
  getPgErrorCode(error) === pgErrorCodes.uniqueViolation;

export const isForeignKeyViolation = (error: unknown) =>
  getPgErrorCode(error) === pgErrorCodes.foreignKeyViolation;

/**
 * The database's own error for a failed query. Drizzle wraps it in an error whose
 * message contains the SQL and parameters, which shouldn't reach users.
 */
export const unwrapDbError = (error: unknown): unknown =>
  error instanceof DrizzleQueryError && error.cause instanceof Error
    ? error.cause
    : error;
