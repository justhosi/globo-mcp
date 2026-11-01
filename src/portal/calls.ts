/**
 * Telephone/audio and video call logs from the portal's DataTables endpoints.
 *
 * Row shape (both logs): `date` (`M/D/YYYY`, already in the account's local
 * timezone), `start`/`end` (`h:mm AM/PM`), `company`, `service`,
 * `call_unique_identifier`, `interpreter_minutes`, `hourly_pay_units`.
 *
 * Duration rule: `interpreter_minutes` is authoritative when it is a positive
 * integer (the portal derives it from exact call timestamps, so it is usually
 * equal to — or one less than — the whole-minute start/end difference).
 * When it is 0, negative, or missing, fall back to the whole-minute start/end
 * difference, treating `end < start` as a midnight crossing (+24h). The raw
 * value is always exposed as `portalMinutes` so callers can see both.
 *
 * Parsing is defensive: a malformed row is skipped with a stderr warning and
 * never fails the whole payload; bad scalar fields become `null`.
 */

import type { PortalAuth } from "../auth.js";
import type { TtlCache } from "./cache.js";

/** Which call log to read. */
export type CallType = "telephone" | "video";

/** Grouping for `globo_call_summary` breakdowns. */
export type GroupBy = "day" | "week" | "month" | "none";

const TELEPHONE_PATH = "/interpreter/calls_index_data?draw=1&start=0&length=10000";
const VIDEO_PATH = "/interpreter/video_calls_index_data?draw=1&start=0&length=10000";

/** One parsed call-log row. */
export interface CallRecord {
  /** Local calendar date, normalized to `YYYY-MM-DD`. */
  date: string;
  /** Raw portal start/end strings (`h:mm AM/PM`). */
  start: string;
  end: string;
  company: string | null;
  service: string | null;
  /** Portal's `call_unique_identifier` (often null on the video log). */
  callId: string | null;
  /** Duration used for totals (hybrid rule above); null when unknowable. */
  minutes: number | null;
  /** Raw portal `interpreter_minutes` value. */
  portalMinutes: number | null;
  /** Portal's `hourly_pay_units` note (`""` becomes null). */
  note: string | null;
}

/** Parsed row plus numeric date parts for filtering/bucketing. */
export interface DatedCall extends CallRecord {
  y: number;
  m: number;
  d: number;
}

/** Calendar day from numeric parts. */
export interface DayParts {
  y: number;
  m: number;
  d: number;
}

function warn(message: string): void {
  console.error(`[globo-mcp] warning: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Parse a portal `M/D/YYYY` date. Returns null for anything else (including
 * impossible calendar dates).
 */
export function parsePortalDate(value: unknown): DayParts | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const m = Number(match[1]);
  const d = Number(match[2]);
  const y = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/**
 * Parse a portal `h:mm AM/PM` time into minutes since midnight.
 * Returns null for anything else.
 */
export function parsePortalTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const min = Number(match[2]);
  const pm = match[3]?.toUpperCase() === "P";
  if (h < 1 || h > 12 || min < 0 || min > 59) return null;
  return ((h % 12) + (pm ? 12 : 0)) * 60 + min;
}

/**
 * Whole-minute difference, treating `end < start` as a midnight crossing.
 * Times only carry minute precision, so no rounding is involved.
 */
export function naiveMinutes(startMin: number, endMin: number): number {
  const diff = endMin - startMin;
  return diff < 0 ? diff + 24 * 60 : diff;
}

/** Format numeric parts as `YYYY-MM-DD`. */
export function formatDay(parts: DayParts): string {
  const mm = String(parts.m).padStart(2, "0");
  const dd = String(parts.d).padStart(2, "0");
  return `${parts.y}-${mm}-${dd}`;
}

/** Numeric day key for comparisons. */
export function dayKey(parts: DayParts): number {
  return parts.y * 10000 + parts.m * 100 + parts.d;
}

/**
 * Parse a user-supplied date (`YYYY-MM-DD` primary, `M/D/YYYY` tolerated).
 *
 * @throws Error naming the accepted formats when the value is unusable.
 */
export function parseDateInput(value: string, which: "start" | "end"): DayParts {
  const trimmed = value.trim();
  let parts: DayParts | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const y = Number(trimmed.slice(0, 4));
    const m = Number(trimmed.slice(5, 7));
    const d = Number(trimmed.slice(8, 10));
    if (m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)) {
      parts = { y, m, d };
    }
  } else {
    parts = parsePortalDate(trimmed);
  }
  if (!parts) {
    throw new Error(
      `Invalid ${which} date ${JSON.stringify(value)}. Use YYYY-MM-DD (e.g. 2026-09-30) or MM/DD/YYYY.`,
    );
  }
  return parts;
}

/** Optional text field: missing/empty/non-string becomes null. */
function textField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warn(`call row has non-string ${JSON.stringify(key)}; treating as missing`);
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Optional non-negative integer field: anything else becomes null. */
function intField(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (value === undefined || value === null) return null;
  warn(`call row has non-integer or negative ${JSON.stringify(key)}; treating as missing`);
  return null;
}

/** Parse one row; null (plus a warning) when the row is unusable. */
function parseRow(row: unknown): DatedCall | null {
  if (!isRecord(row)) {
    warn("skipping malformed call row (not an object)");
    return null;
  }
  const date = parsePortalDate(row["date"]);
  if (!date) {
    warn("skipping call row with an unparseable date");
    return null;
  }
  const portalMinutes = intField(row, "interpreter_minutes");
  const startMin = parsePortalTime(row["start"]);
  const endMin = parsePortalTime(row["end"]);
  let minutes: number | null = null;
  if (portalMinutes !== null && portalMinutes !== 0) {
    minutes = portalMinutes;
  } else if (startMin !== null && endMin !== null) {
    minutes = naiveMinutes(startMin, endMin);
  }
  if (minutes === null) {
    warn("call row has no usable duration; minutes will be null");
  }
  const startRaw = typeof row["start"] === "string" ? row["start"] : "";
  const endRaw = typeof row["end"] === "string" ? row["end"] : "";
  return {
    date: formatDay(date),
    start: startRaw,
    end: endRaw,
    company: textField(row, "company"),
    service: textField(row, "service"),
    callId: textField(row, "call_unique_identifier"),
    minutes,
    portalMinutes,
    note: textField(row, "hourly_pay_units"),
    y: date.y,
    m: date.m,
    d: date.d,
  };
}

/**
 * Parse a call-log payload. Throws a friendly error when the envelope itself
 * is malformed; skips bad rows with warnings.
 */
export function parseCallLog(payload: unknown): DatedCall[] {
  if (!isRecord(payload) || !Array.isArray(payload["data"])) {
    throw new Error(
      "The portal's call log came back in an unexpected format. The portal may have changed or be down.",
    );
  }
  const rows: DatedCall[] = [];
  for (const row of payload["data"]) {
    const parsed = parseRow(row);
    if (parsed) rows.push(parsed);
  }
  // Compare what the portal sent, not what survived parsing: one skipped
  // malformed row must not emit a false "truncated" warning.
  const total = payload["recordsTotal"];
  if (typeof total === "number" && payload["data"].length < total) {
    warn(`call log truncated by the portal (${payload["data"].length} of ${total} rows)`);
  }
  return rows;
}

/** Fetch (and cache) one call log. */
export async function fetchCallLog(
  auth: PortalAuth,
  cache: TtlCache,
  type: CallType,
): Promise<DatedCall[]> {
  const path = type === "telephone" ? TELEPHONE_PATH : VIDEO_PATH;
  const key = new URL(path, auth.client.baseUrl).href;
  const cached = cache.get<DatedCall[]>(key);
  if (cached) return cached;
  const result = await auth.fetchWithAuth(path);
  if (result.status !== 200) {
    throw new Error(
      `Could not load the ${type} call log (HTTP ${result.status}). The portal may be down.`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.text) as unknown;
  } catch {
    throw new Error(
      `The portal's ${type} call log came back in an unexpected format. The portal may have changed or be down.`,
    );
  }
  const rows = parseCallLog(payload);
  cache.set(key, rows);
  return rows;
}

/** Range + substring filters shared by the summary and list tools. */
export interface CallFilter {
  start?: DayParts;
  end?: DayParts;
  company?: string;
  service?: string;
  minMinutes?: number;
}

/** True when a call falls inside the inclusive local-date range and matches. */
export function matchesFilter(call: DatedCall, filter: CallFilter): boolean {
  if (filter.start && dayKey(call) < dayKey(filter.start)) return false;
  if (filter.end && dayKey(call) > dayKey(filter.end)) return false;
  if (filter.company && !(call.company ?? "").toLowerCase().includes(filter.company)) return false;
  if (filter.service && !(call.service ?? "").toLowerCase().includes(filter.service)) return false;
  if (filter.minMinutes !== undefined && (call.minutes ?? -1) < filter.minMinutes) return false;
  return true;
}

/** Filter rows, keeping the date parts needed for bucketing. */
export function filterCalls(calls: DatedCall[], filter: CallFilter): DatedCall[] {
  return calls.filter((call) => matchesFilter(call, filter));
}

/** ISO week bucket (`YYYY-Www`, Monday start) for a local date. */
export function isoWeekBucket(parts: DayParts): string {
  const dt = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  const mondayBased = (dt.getUTCDay() + 6) % 7;
  const thursday = new Date(dt.getTime() + (3 - mondayBased) * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const week = 1 + Math.round((thursday.getTime() - jan4) / 604_800_000);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Bucket key for a call under the given grouping. */
export function bucketFor(call: DatedCall, groupBy: Exclude<GroupBy, "none">): string {
  if (groupBy === "day") return call.date;
  if (groupBy === "week") return isoWeekBucket(call);
  return `${call.y}-${String(call.m).padStart(2, "0")}`;
}

/** Round to 2 decimal places (for hours). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Call/minute/hour totals for one set of rows (null minutes are skipped). */
export interface CallTotals {
  calls: number;
  minutes: number;
  hours: number;
}

export function totalOf(calls: CallRecord[]): CallTotals {
  let minutes = 0;
  for (const call of calls) {
    if (call.minutes !== null) minutes += call.minutes;
  }
  return { calls: calls.length, minutes, hours: round2(minutes / 60) };
}

/** Full summary response for `globo_call_summary`. */
export interface CallSummary {
  range: { start: string | null; end: string | null; timezone: string };
  totals: { telephone: CallTotals; video: CallTotals; combined: CallTotals };
  breakdown?: BreakdownRow[];
}

export interface SummaryOptions {
  start?: DayParts;
  end?: DayParts;
  timezone: string;
  wantTelephone: boolean;
  wantVideo: boolean;
  groupBy: GroupBy;
}

/** Build the summary from already-fetched logs. */
export function summarizeCalls(
  telephone: DatedCall[],
  video: DatedCall[],
  opts: SummaryOptions,
): CallSummary {
  const range = { start: opts.start, end: opts.end };
  const tel = opts.wantTelephone ? filterCalls(telephone, range) : [];
  const vid = opts.wantVideo ? filterCalls(video, range) : [];
  const telTotals = totalOf(tel);
  const vidTotals = totalOf(vid);
  const summary: CallSummary = {
    range: {
      start: opts.start ? formatDay(opts.start) : null,
      end: opts.end ? formatDay(opts.end) : null,
      timezone: opts.timezone,
    },
    totals: {
      telephone: telTotals,
      video: vidTotals,
      combined: {
        calls: telTotals.calls + vidTotals.calls,
        minutes: telTotals.minutes + vidTotals.minutes,
        hours: round2((telTotals.minutes + vidTotals.minutes) / 60),
      },
    },
  };
  if (opts.groupBy !== "none") {
    summary.breakdown = buildBreakdown(tel, vid, opts.groupBy);
  }
  return summary;
}

/** One listed call for `globo_list_calls`. */
export interface ListedCall {
  date: string;
  start: string;
  end: string;
  company: string | null;
  service: string | null;
  callId: string | null;
  minutes: number | null;
  portalMinutes: number | null;
  note: string | null;
}

/** Paged list response for `globo_list_calls`. */
export interface CallList {
  total: number;
  returned: number;
  offset: number;
  calls: ListedCall[];
}

/** Filter, then page. Page bounds are validated by the caller. */
export function listCalls(
  calls: DatedCall[],
  filter: CallFilter,
  limit: number,
  offset: number,
): CallList {
  const filtered = filterCalls(calls, filter);
  const page = filtered.slice(offset, offset + limit);
  return {
    total: filtered.length,
    returned: page.length,
    offset,
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

/** One grouped breakdown row. */
export interface BreakdownRow {
  bucket: string;
  telephone_calls: number;
  telephone_minutes: number;
  video_calls: number;
  video_minutes: number;
  total_minutes: number;
}

/** Group filtered rows; buckets sorted ascending. */
export function buildBreakdown(
  telephone: DatedCall[],
  video: DatedCall[],
  groupBy: Exclude<GroupBy, "none">,
): BreakdownRow[] {
  const buckets = new Map<string, { tel: DatedCall[]; vid: DatedCall[] }>();
  const add = (call: DatedCall, key: "tel" | "vid") => {
    const bucket = bucketFor(call, groupBy);
    let entry = buckets.get(bucket);
    if (!entry) {
      entry = { tel: [], vid: [] };
      buckets.set(bucket, entry);
    }
    entry[key].push(call);
  };
  for (const call of telephone) add(call, "tel");
  for (const call of video) add(call, "vid");
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucket, entry]) => {
      const tel = totalOf(entry.tel);
      const vid = totalOf(entry.vid);
      return {
        bucket,
        telephone_calls: tel.calls,
        telephone_minutes: tel.minutes,
        video_calls: vid.calls,
        video_minutes: vid.minutes,
        total_minutes: tel.minutes + vid.minutes,
      };
    });
}
