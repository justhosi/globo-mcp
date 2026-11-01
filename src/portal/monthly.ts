/**
 * Portal's own monthly rollup (`/interpreter/monthly_minutes_data`).
 *
 * These are post-audit numbers, so they can differ slightly from totals
 * recomputed from the call logs (audited calls may change or drop out).
 * Month labels arrive as `"10 / 2025"` and are normalized to `"2025-10"`.
 */

import type { PortalAuth } from "../auth.js";
import type { TtlCache } from "./cache.js";

const MONTHLY_PATH = "/interpreter/monthly_minutes_data?draw=1&start=0&length=100";

/** One month of the portal's rollup. */
export interface MonthMinutes {
  /** Normalized month key, `YYYY-MM`. */
  month: string;
  calls: number;
  minutes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a portal month label (`"10 / 2025"`) to `"2025-10"`.
 * Returns null for anything else.
 */
export function normalizeMonth(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{4})\s*$/.exec(value);
  if (!match) return null;
  const m = Number(match[1]);
  if (m < 1 || m > 12) return null;
  return `${match[2]}-${String(m).padStart(2, "0")}`;
}

/** Parse one rollup row; null (plus a warning) when unusable. */
function parseMonthRow(row: unknown): MonthMinutes | null {
  if (!isRecord(row)) {
    console.error("[globo-mcp] warning: skipping malformed monthly row (not an object)");
    return null;
  }
  const month = normalizeMonth(row["month"]);
  const calls = row["total_calls"];
  const minutes = row["total_minutes"];
  if (!month || typeof calls !== "number" || typeof minutes !== "number") {
    console.error("[globo-mcp] warning: skipping monthly row with missing fields");
    return null;
  }
  return { month, calls, minutes };
}

/**
 * Parse a monthly-rollup payload, sorted ascending by month. Throws a
 * friendly error on a malformed envelope; skips bad rows with warnings.
 */
export function parseMonthlyMinutes(payload: unknown): MonthMinutes[] {
  if (!isRecord(payload) || !Array.isArray(payload["data"])) {
    throw new Error(
      "The portal's monthly minutes came back in an unexpected format. The portal may have changed or be down.",
    );
  }
  const months: MonthMinutes[] = [];
  for (const row of payload["data"]) {
    const parsed = parseMonthRow(row);
    if (parsed) months.push(parsed);
  }
  months.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  return months;
}

/** Fetch (and cache) the portal's monthly rollup. */
export async function fetchMonthlyMinutes(
  auth: PortalAuth,
  cache: TtlCache,
): Promise<MonthMinutes[]> {
  const key = new URL(MONTHLY_PATH, auth.client.baseUrl).href;
  const cached = cache.get<MonthMinutes[]>(key);
  if (cached) return cached;
  const result = await auth.fetchWithAuth(MONTHLY_PATH);
  if (result.status !== 200) {
    throw new Error(
      `Could not load the monthly minutes (HTTP ${result.status}). The portal may be down.`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.text) as unknown;
  } catch {
    throw new Error(
      "The portal's monthly minutes came back in an unexpected format. The portal may have changed or be down.",
    );
  }
  const months = parseMonthlyMinutes(payload);
  cache.set(key, months);
  return months;
}
