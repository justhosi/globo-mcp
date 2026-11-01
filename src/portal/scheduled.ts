/**
 * Scheduled interpreting appointments from the server-rendered
 * `/scheduled_calls` page: one static `table#table-calls` (plain `<tbody>`,
 * no XHR) holding the signed-in user's whole history.
 *
 * PRIVACY WARNING — do not replace this scraper with
 * `GET /scheduled_calls/get_data`. That endpoint looks like the JSON version
 * of this table but is NOT user-scoped: it returns the whole platform's
 * schedule (tens of thousands of other people's participant names, phone
 * numbers, and appointments) and zero rows for the signed-in user. The
 * per-user table scraped here is the only safe source. (`/scheduled_calls`
 * `/export` is also unusable: it returns HTTP 500.)
 *
 * Row shape: `Project Number`, `Type`, `Company`, `Language`, `Start Date`
 * (`M/D/YYYY` — the only source of `date`; unparseable text yields
 * `date: null` with the raw text kept in `dateRaw`), `Start Time`
 * (`h:mm AM/PM`), `Status`, `Duration` (free text: `40m`, `1h 30m`, `HH:MM`,
 * `N/A`, empty), `Actions` (often whitespace-only; sometimes a Details link).
 *
 * Note: the Start Date cell carries a `data-sort` attribute, but its values
 * are not a date in any justifiable unit (deltas between rows are not linear
 * in the scheduled date), so it is ignored entirely — a fallback that
 * silently yields year 2179 is worse than an honest null.
 *
 * `upcoming_only` compares the row's wall-clock date+time against "now" in
 * the account timezone (resolved by the caller via `getAccountTimezone`);
 * without a timezone it falls back to UTC and says so in the `note`.
 *
 * Parsing is defensive: a malformed row is skipped with a stderr warning and
 * never fails the whole page; bad scalar fields become `null`.
 */

import type { PortalAuth } from "../auth.js";
import type { TtlCache } from "./cache.js";
import { dayKey, formatDay, parsePortalDate, parsePortalTime, type DayParts } from "./calls.js";

const SCHEDULED_PATH = "/scheduled_calls";

/** One scheduled appointment. */
export interface ScheduledCall {
  projectNumber: string | null;
  type: string | null;
  company: string | null;
  language: string | null;
  /**
   * Scheduled date, ISO `YYYY-MM-DD` in the portal's wall clock, or null
   * when the cell text does not parse (see `dateRaw`).
   */
  date: string | null;
  /** Raw Start Date cell text, exactly as shown (`""` when the cell is missing). */
  dateRaw: string;
  /** Raw Start Time cell (`h:mm AM/PM`); `""` when the cell is missing. */
  time: string;
  status: string | null;
  /** Raw Duration cell (null when empty/missing). */
  duration: string | null;
  /**
   * Duration in minutes (`40m` → 40, `1h 30m` → 90, `HH:MM` → h*60+m);
   * null for `N/A`, empty, or unparseable text.
   */
  durationMinutes: number | null;
  /** Absolute-path Details href (`/scheduled_calls/<id>`) when the row has one. */
  detailsUrl: string | null;
}

/** Parsed row plus numeric parts for filtering/ordering (null when `date` is null). */
export interface DatedScheduledCall extends ScheduledCall {
  y: number | null;
  m: number | null;
  d: number | null;
  /** Start-time minutes since midnight; null when missing/unparseable. */
  startMin: number | null;
}

function warn(message: string): void {
  console.error(`[globo-mcp] warning: ${message}`);
}

/** Collapse whitespace, decode a few entities, and trim. */
function clean(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip any nested tags, then clean. */
function textOf(rawHtml: string): string {
  return clean(rawHtml.replace(/<[^>]*>/g, " "));
}

/** Inner HTML of each `<td>` cell of a row, in order. */
function cellsOf(rowHtml: string): string[] {
  const cells: string[] = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rowHtml)) !== null) {
    cells.push(match[1] ?? "");
  }
  return cells;
}

/** Text cell: cleaned text, or null when empty. */
function textCell(cell: string | undefined): string | null {
  if (cell === undefined) return null;
  const text = textOf(cell);
  return text === "" ? null : text;
}

/** Numeric date parts, or null when the row's date is unknown. */
function datedParts(call: DatedScheduledCall): DayParts | null {
  if (call.y === null || call.m === null || call.d === null) return null;
  return { y: call.y, m: call.m, d: call.d };
}

/**
 * Wall-clock calendar parts of an instant in `timeZone` (`hourCycle: "h23"`
 * so midnight is 00:xx, never 24:xx). No new dependency: `Intl` is built in.
 * `timeZone` must be a valid IANA name; anything else throws a RangeError
 * naming it.
 */
function wallClockParts(
  instant: Date,
  timeZone: string,
): { y: number; m: number; d: number; min: number } {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string): number => Number(fields.find((part) => part.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), min: get("hour") * 60 + get("minute") };
}

/** Details link when the cell holds one (`/scheduled_calls/<id>`), else null. */
function detailsUrlOf(cell: string | undefined): string | null {
  if (cell === undefined) return null;
  const href = /<a[^>]*href="([^"]*)"[^>]*>/i.exec(cell)?.[1]?.trim() ?? "";
  return href.startsWith("/scheduled_calls/") ? href : null;
}

/**
 * Parse a free-text Duration cell into minutes. Returns null for empty,
 * `N/A`, or anything unrecognized (the raw string is always kept alongside).
 */
export function parseDurationMinutes(value: string | null): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (text === "" || /^n\/a$/i.test(text)) return null;
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(text);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    return Number(clock[1]) * 60 + Number(clock[2]);
  }
  const parts = /^(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i.exec(text);
  if (parts && (parts[1] !== undefined || parts[2] !== undefined)) {
    return (
      (parts[1] === undefined ? 0 : Number(parts[1]) * 60) +
      (parts[2] === undefined ? 0 : Number(parts[2]))
    );
  }
  return null;
}

/** Parse one table row; null (plus a warning) only when cells are missing. */
function parseRow(rowHtml: string): DatedScheduledCall | null {
  const cells = cellsOf(rowHtml);
  if (cells.length < 9) {
    warn("skipping scheduled row with missing cells");
    return null;
  }
  // The visible text is the only date source. Unparseable text keeps the row
  // alive with `date: null` (never throws); the raw text stays in `dateRaw`.
  const dateRaw = textOf(cells[4] ?? "");
  const date = parsePortalDate(dateRaw);
  if (!date) {
    warn("scheduled row has an unparseable date; keeping it with date null");
  }
  const time = textOf(cells[5] ?? "");
  const duration = textCell(cells[7]);
  return {
    projectNumber: textCell(cells[0]),
    type: textCell(cells[1]),
    company: textCell(cells[2]),
    language: textCell(cells[3]),
    date: date ? formatDay(date) : null,
    dateRaw,
    time,
    status: textCell(cells[6]),
    duration,
    durationMinutes: parseDurationMinutes(duration),
    detailsUrl: detailsUrlOf(cells[8]),
    y: date?.y ?? null,
    m: date?.m ?? null,
    d: date?.d ?? null,
    startMin: time === "" ? null : parsePortalTime(time),
  };
}

/**
 * Parse the `/scheduled_calls` page. Throws a friendly error when the table
 * is missing (the page changed); an empty `<tbody>` yields zero rows.
 */
export function parseScheduledCalls(html: string): DatedScheduledCall[] {
  const table = /<table[^>]*\bid\s*=\s*["']?table-calls["']?[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!table?.[1]) {
    throw new Error(
      "The portal's scheduled-calls table is missing. The portal may have changed or be down.",
    );
  }
  // The header row holds `<th>` cells, so only `<tr>` rows with `<td>` cells
  // are data; a `<tbody>`-less table still parses.
  const rows: DatedScheduledCall[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(table[1])) !== null) {
    const rowHtml = match[1] ?? "";
    if (!/<td[\s>]/.test(rowHtml)) continue;
    const parsed = parseRow(rowHtml);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

/** Fetch (and cache) the scheduled-calls page. */
export async function fetchScheduledCalls(
  auth: PortalAuth,
  cache: TtlCache,
): Promise<DatedScheduledCall[]> {
  const key = new URL(SCHEDULED_PATH, auth.client.baseUrl).href;
  const cached = cache.get<DatedScheduledCall[]>(key);
  if (cached) return cached;
  const result = await auth.fetchWithAuth(SCHEDULED_PATH);
  if (result.status !== 200) {
    throw new Error(
      `Could not load the scheduled calls page (HTTP ${result.status}). The portal may be down.`,
    );
  }
  const rows = parseScheduledCalls(result.text);
  cache.set(key, rows);
  return rows;
}

/** Filters for `globo_scheduled_calls`. Text matches are pre-lowercased. */
export interface ScheduledFilter {
  /** Case-insensitive exact match on the portal status (`completed`, …). */
  status?: string;
  /** Case-insensitive exact match on the portal type (`video`, …). */
  type?: string;
  /** Case-insensitive substring on the company. */
  company?: string;
  start?: DayParts;
  end?: DayParts;
  /** Keep only rows scheduled strictly after `now`. */
  upcomingOnly?: boolean;
  /**
   * Resolved account timezone (IANA) for `upcomingOnly`; undefined falls back
   * to UTC. Must be a valid IANA name — anything else throws a RangeError
   * naming it.
   */
  timezone?: string;
  /**
   * Absolute "now" for `upcomingOnly` (defaults to the wall clock).
   * Injectable so tests never depend on the real clock.
   */
  now?: Date;
}

/** True when a row survives the range, text, and upcoming filters. */
export function matchesScheduled(call: DatedScheduledCall, filter: ScheduledFilter): boolean {
  const parts = datedParts(call);
  if (parts !== null) {
    if (filter.start && dayKey(parts) < dayKey(filter.start)) return false;
    if (filter.end && dayKey(parts) > dayKey(filter.end)) return false;
  } else if (filter.start !== undefined || filter.end !== undefined) {
    // A range cannot be satisfied by an unknown date.
    return false;
  }
  if (filter.status !== undefined && (call.status ?? "").toLowerCase() !== filter.status) {
    return false;
  }
  if (filter.type !== undefined && (call.type ?? "").toLowerCase() !== filter.type) return false;
  if (filter.company && !(call.company ?? "").toLowerCase().includes(filter.company)) return false;
  if (filter.upcomingOnly) {
    if (filter.status === undefined) {
      // Without an explicit status, past-tense rows are noise: drop them.
      const status = (call.status ?? "").toLowerCase();
      if (status === "completed" || status === "cancelled") return false;
    }
    // Both sides as the same wall clock: the row's date+time against "now"
    // in the account timezone (UTC when unresolved). A missing time counts
    // as the start of the day; an unknown date (NaN) is never upcoming.
    const wall = wallClockParts(filter.now ?? new Date(), filter.timezone ?? "UTC");
    const rowDay = parts === null ? NaN : dayKey(parts);
    const nowDay = wall.y * 10000 + wall.m * 100 + wall.d;
    const rowMin = call.startMin ?? 0;
    if (!(rowDay > nowDay || (rowDay === nowDay && rowMin > wall.min))) return false;
  }
  return true;
}

/**
 * Newest first by scheduled date+time; rows with an unknown date sort last
 * regardless, and full ties keep page order (stable sort).
 */
function byNewestFirst(a: DatedScheduledCall, b: DatedScheduledCall): number {
  const ad = datedParts(a);
  const bd = datedParts(b);
  if (ad === null && bd === null) return 0;
  if (ad === null) return 1;
  if (bd === null) return -1;
  if (ad.y !== bd.y) return bd.y - ad.y;
  if (ad.m !== bd.m) return bd.m - ad.m;
  if (ad.d !== bd.d) return bd.d - ad.d;
  return (b.startMin ?? 0) - (a.startMin ?? 0);
}

/** Paged list response for `globo_scheduled_calls`. */
export interface ScheduledList {
  total: number;
  returned: number;
  offset: number;
  /**
   * Always null, deliberately: the page shows wall-clock date/time with no
   * stated timezone, so no honest value exists. See `note`.
   */
  timezone: null;
  note: string;
  calls: ScheduledCall[];
}

/** Base note: the page shows wall-clock values with no stated timezone. */
const TIMEZONE_NOTE =
  "Times are the wall-clock values shown in the portal; the page does not state a timezone.";

/** Filter, order newest-first, then page. Page bounds are validated by the caller. */
export function listScheduledCalls(
  calls: DatedScheduledCall[],
  filter: ScheduledFilter,
  limit: number,
  offset: number,
): ScheduledList {
  const filtered = calls.filter((call) => matchesScheduled(call, filter)).sort(byNewestFirst);
  const page = filtered.slice(offset, offset + limit);
  // The UTC note only matters when upcoming filtering actually ran without a
  // resolved timezone; otherwise it would cry wolf on plain listings.
  const note =
    filter.timezone === undefined && filter.upcomingOnly
      ? `${TIMEZONE_NOTE} Account timezone unavailable; upcoming filtering used UTC.`
      : TIMEZONE_NOTE;
  return {
    total: filtered.length,
    returned: page.length,
    offset,
    timezone: null,
    note,
    calls: page.map((call) => ({
      projectNumber: call.projectNumber,
      type: call.type,
      company: call.company,
      language: call.language,
      date: call.date,
      dateRaw: call.dateRaw,
      time: call.time,
      status: call.status,
      duration: call.duration,
      durationMinutes: call.durationMinutes,
      detailsUrl: call.detailsUrl,
    })),
  };
}
