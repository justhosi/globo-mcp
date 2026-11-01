/**
 * Tool pagination guards shared by the list tools, so the `limit` cap and
 * its error message stay identical everywhere.
 */

/** Page sizes above this are rejected; the logs are small enough to page. */
export const MAX_PAGE = 1000;

/**
 * Validate `limit`/`offset`/`min_minutes` tool input.
 *
 * @throws Error with an actionable message when a value is unusable.
 */
export function checkPaging(limit: number, offset: number, minMinutes?: number): void {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PAGE) {
    throw new Error(
      `Invalid limit ${JSON.stringify(limit)}. Use an integer between 0 and ${MAX_PAGE}.`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid offset ${JSON.stringify(offset)}. Use a non-negative integer.`);
  }
  if (minMinutes !== undefined && !(minMinutes >= 0)) {
    throw new Error(
      `Invalid min_minutes ${JSON.stringify(minMinutes)}. Use a non-negative number of minutes.`,
    );
  }
}
