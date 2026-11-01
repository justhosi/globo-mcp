/**
 * Assignment history from the portal's DataTables endpoint
 * (`/interpreter/assignments_index_data`).
 *
 * Rows share the call-log shape (`date`, `start`/`end`, `company`,
 * `service`, `call_unique_identifier`, `interpreter_minutes`,
 * `hourly_pay_units`), so row parsing, the hybrid duration rule, and the
 * filter shape are reused from `./calls.js` rather than copied. Only ever
 * call the documented `_index_data` path; never explore sibling endpoints.
 *
 * `hourly_pay_units` is the portal's "Additional Information" column: a
 * free-text note, never a number. It is trimmed and exposed as `note`
 * (`""` becomes null), never coerced numerically.
 *
 * Parsing is defensive: a malformed row is skipped with a stderr warning and
 * never fails the whole payload; bad scalar fields become `null`. Rows with
 * an unparseable date are kept with `date: null` and sort last (same rule as
 * the scheduled tool).
 */

import type { PortalAuth } from "../auth.js";
import type { TtlCache } from "./cache.js";
import {
  type CallFilter,
  type CallTotals,
  datedParts,
  dayKey,
  formatDay,
  intField,
  isRecord,
  matchesFilter,
  parsePortalDate,
  parsePortalTime,
  resolveMinutes,
  textField,
  totalOf,
} from "./calls.js";

const ASSIGNMENTS_PATH = "/interpreter/assignments_index_data?draw=1&start=0&length=10000";

/** One assignment history row for `globo_assignments` output. */
export interface AssignmentCall {
  /** Local calendar date, ISO `YYYY-MM-DD`; null when unparseable (row kept). */
  date: string | null;
  /** Raw portal start/end strings (`h:mm AM/PM`). */
  start: string;
  end: string;
  company: string | null;
  service: string | null;
  /** Portal's `call_unique_identifier` (`AR…` on assignments). */
  callId: string | null;
  /** Duration used for totals (hybrid rule from `./calls.js`); null when unknowable. */
  minutes: number | null;
  /** Raw portal `interpreter_minutes` value (null unless a non-negative integer). */
  portalMinutes: number | null;
  /** Portal's `hourly_pay_units` free-text note (`""` becomes null). */
  note: string | null;
}

/** Parsed row plus numeric date parts (null when `date` is null). */
export interface DatedAssignment extends AssignmentCall {
  y: number | null;
  m: number | null;
  d: number | null;
  /** Start-time minutes since midnight; null when missing/unparseable. */
  startMin: number | null;
}

function warn(message: string): void {
  console.error(`[globo-mcp] warning: ${message}`);
}

/** Parse one row; null (plus a warning) only when the row is not an object. */
function parseRow(row: unknown): DatedAssignment | null {
  if (!isRecord(row)) {
    warn("skipping malformed assignment row (not an object)");
    return null;
  }
  const dateRaw = typeof row["date"] === "string" ? row["date"] : "";
  const date = parsePortalDate(dateRaw);
  if (!date) {
    warn("assignment row has an unparseable date; keeping it with date null");
  }
  const portalMinutes = intField(row, "interpreter_minutes");
  const startMin = parsePortalTime(row["start"]);
  const endMin = parsePortalTime(row["end"]);
  const minutes = resolveMinutes(portalMinutes, startMin, endMin);
  if (minutes === null) {
    warn("assignment row has no usable duration; minutes will be null");
  }
  const startRaw = typeof row["start"] === "string" ? row["start"] : "";
  const endRaw = typeof row["end"] === "string" ? row["end"] : "";
  return {
    date: date ? formatDay(date) : null,
    start: startRaw,
    end: endRaw,
    company: textField(row, "company"),
    service: textField(row, "service"),
    callId: textField(row, "call_unique_identifier"),
    minutes,
    portalMinutes,
    note: textField(row, "hourly_pay_units"),
    y: date?.y ?? null,
    m: date?.m ?? null,
    d: date?.d ?? null,
    startMin,
  };
}

/**
 * Parse an assignment-history payload. Throws a friendly error when the
 * envelope itself is malformed; skips bad rows with warnings.
 */
export function parseAssignmentLog(payload: unknown): DatedAssignment[] {
  if (!isRecord(payload) || !Array.isArray(payload["data"])) {
    throw new Error(
      "The portal's assignment history came back in an unexpected format. The portal may have changed or be down.",
    );
  }
  const rows: DatedAssignment[] = [];
  for (const row of payload["data"]) {
    const parsed = parseRow(row);
    if (parsed) rows.push(parsed);
  }
  // Compare what the portal sent, not what survived parsing: one skipped
  // malformed row must not emit a false "truncated" warning.
  const total = payload["recordsTotal"];
  if (typeof total === "number" && payload["data"].length < total) {
    warn(`assignment history truncated by the portal (${payload["data"].length} of ${total} rows)`);
  }
  return rows;
}

/** Fetch (and cache) the assignment history. */
export async function fetchAssignments(
  auth: PortalAuth,
  cache: TtlCache,
): Promise<DatedAssignment[]> {
  const key = new URL(ASSIGNMENTS_PATH, auth.client.baseUrl).href;
  const cached = cache.get<DatedAssignment[]>(key);
  if (cached) return cached;
  const result = await auth.fetchWithAuth(ASSIGNMENTS_PATH);
  if (result.status !== 200) {
    throw new Error(
      `Could not load the assignment history (HTTP ${result.status}). The portal may be down.`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.text) as unknown;
  } catch {
    throw new Error(
      "The portal's assignment history came back in an unexpected format. The portal may have changed or be down.",
    );
  }
  const rows = parseAssignmentLog(payload);
  cache.set(key, rows);
  return rows;
}

/**
 * True when an assignment survives the shared range/substring/duration
 * filter. Rows with an unknown date are excluded by `start`/`end` (a range
 * cannot be satisfied by an unknown date); other filters still apply.
 */
export function matchesAssignment(call: DatedAssignment, filter: CallFilter): boolean {
  const parts = datedParts(call);
  if (parts === null && (filter.start !== undefined || filter.end !== undefined)) {
    // A range cannot be satisfied by an unknown date (same rule as scheduled).
    return false;
  }
  // Day parts are only consulted when a range is set, which unknown dates
  // never satisfy (see above); otherwise the epoch placeholder is inert and
  // the company/service/minutes checks still apply.
  return matchesFilter({ ...call, ...(parts ?? { y: 1970, m: 1, d: 1 }) }, filter);
}

/**
 * Newest first by scheduled date+time; rows with an unknown date sort last
 * regardless, and full ties keep page order (stable sort).
 */
function compareNewestFirst(a: DatedAssignment, b: DatedAssignment): number {
  const ad = datedParts(a);
  const bd = datedParts(b);
  if (ad === null && bd === null) return 0;
  if (ad === null) return 1;
  if (bd === null) return -1;
  if (dayKey(ad) !== dayKey(bd)) return dayKey(bd) - dayKey(ad);
  return (b.startMin ?? 0) - (a.startMin ?? 0);
}

/** Paged list response for `globo_assignments`. */
export interface AssignmentList {
  total: number;
  returned: number;
  offset: number;
  /** Totals over all filtered rows, not just the returned page. */
  totals: CallTotals;
  calls: AssignmentCall[];
}

/** Filter, order newest-first, then page. Page bounds are validated by the caller. */
export function listAssignments(
  calls: DatedAssignment[],
  filter: CallFilter,
  limit: number,
  offset: number,
): AssignmentList {
  const filtered = calls.filter((call) => matchesAssignment(call, filter)).sort(compareNewestFirst);
  const page = filtered.slice(offset, offset + limit);
  return {
    total: filtered.length,
    returned: page.length,
    offset,
    totals: totalOf(filtered),
    calls: page.map((call) => ({
      date: call.date,
      start: call.start,
      end: call.end,
      company: call.company,
      service: call.service,
      callId: call.callId,
      minutes: call.minutes,
      portalMinutes: call.portalMinutes,
      note: call.note,
    })),
  };
}
