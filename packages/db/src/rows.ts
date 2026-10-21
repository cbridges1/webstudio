/** Thrown when a query that must return exactly one row returns none. */
export class RowNotFoundError extends Error {
  constructor(what = "Row") {
    super(`${what} not found`);
    this.name = "RowNotFoundError";
  }
}

/** The only row, like PostgREST's `.single()`: throws on zero or several rows. */
export const one = <Row>(rows: readonly Row[], what?: string): Row => {
  if (rows.length === 0) {
    throw new RowNotFoundError(what);
  }
  if (rows.length > 1) {
    throw new Error(`Expected one ${what ?? "row"}, got ${rows.length}`);
  }
  return rows[0];
};

/** The only row or null, like PostgREST's `.maybeSingle()`. */
export const maybeOne = <Row>(
  rows: readonly Row[],
  what?: string
): Row | null => {
  if (rows.length > 1) {
    throw new Error(
      `Expected at most one ${what ?? "row"}, got ${rows.length}`
    );
  }
  return rows[0] ?? null;
};
