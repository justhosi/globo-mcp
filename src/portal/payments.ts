/**
 * Payout history from Tipalti, the portal's payout provider. The portal's
 * own `/interpreter/payments_index` page is empty for Tipalti accounts, so
 * the history is reachable only through a three-step chain (all verified
 * live):
 *
 * 1. `GET /users/edit` (portal session) → profile HTML with `<iframe>` tags
 *    whose `src` values are HTML-escaped Tipalti dashboard URLs. The panel is
 *    the one at path `/PayeeDashboard/PaymentsHistory`.
 * 2. `GET` that panel URL → page HTML containing a `token = '<uuid>'` JS
 *    literal used as the API's `authorizationtoken` header.
 * 3. `POST https://ui2.tipalti.com/api/v0/PayeePaymentHistory/GetPayeePaymentHistory`
 *    with that header → the JSON payment history.
 *
 * `ts`/`hashkey` are regenerated on every profile load, so the iframe URL
 * and the token are re-derived per refresh — never cached, only the parsed
 * payment list is. Only ever call the documented Tipalti host and paths;
 * never explore sibling endpoints.
 *
 * Isolation: Tipalti requests use bare `fetch` and never touch the cookie
 * jar, so the portal session cookie cannot travel to Tipalti and Tipalti
 * cookies are never stored. The token lives in a local and is only ever
 * sent to the Tipalti API host — never to the portal, never to logs.
 * Errors are fixed strings (plus the HTTP status); the token, `hashkey`,
 * and `ts` never appear in any message, warning, or stdout.
 */

import type { PortalAuth } from "../auth.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  formatBudget,
  isRedirect,
  isTipaltiUrl,
  TIPALT_HOST,
} from "../http.js";
import type { TtlCache } from "./cache.js";
import {
  datedParts,
  dayKey,
  daysInMonth,
  formatDay,
  isRecord,
  parsePortalDate,
  round2,
  type DayParts,
} from "./calls.js";

const PROFILE_PATH = "/users/edit";
/** Exact panel path: the iframe URL must match host *and* path. */
const TIPALT_PANEL_PATH = "/PayeeDashboard/PaymentsHistory";
const TIPALT_API_URL = `https://${TIPALT_HOST}/api/v0/PayeePaymentHistory/GetPayeePaymentHistory`;
const TIPALT_HISTORY_BODY = '{"pagingData":{"PageCount":1,"PageSize":100}}';
const MAX_TIPALT_HOPS = 10;
/**
 * Cache key for the parsed list. Deliberately not the iframe URL or token:
 * both are regenerated per profile load and must never be cached.
 */
const PAYMENTS_CACHE_KEY = "tipalti:payee-payment-history";

/** Token literal in the panel page (`token = '<36-char uuid>'`). */
const TIPALT_TOKEN_RE = /\btoken\s*=\s*'([0-9a-f-]{36})'/;

/** English month abbreviations/names → month number (Tipalti displays English). */
const ENGLISH_MONTHS: Record<string, number | undefined> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** One payout for `globo_payments` output. */
export interface Payment {
  /** Payment date, ISO `YYYY-MM-DD`; null when unparseable (row kept). */
  date: string | null;
  /** Amount in `currency` units; null when unparseable (see `amountRaw`). */
  amount: number | null;
  /** ISO currency code as displayed (`USD`); null when unparseable. */
  currency: string | null;
  /** Raw `displayedAmountSubmitted` text (null when missing/empty). */
  amountRaw: string | null;
  status: string | null;
  /** Portal's `paymentMethod` (`Direct Deposit / ACH`, …). */
  method: string | null;
  /** Portal's `poId`. */
  paymentId: number | null;
  /** Portal's `payerEntityName`. */
  payer: string | null;
  /** Portal's `canDownloadPaymentDetailsReport` (false unless literally true). */
  reportAvailable: boolean;
}

/** Parsed row plus numeric date parts (null when `date` is null). */
export interface DatedPayment extends Payment {
  y: number | null;
  m: number | null;
  d: number | null;
}

function warn(message: string): void {
  console.error(`[globo-mcp] warning: ${message}`);
}

/** Optional text field: missing/empty/non-string becomes null. */
function paymentText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warn(`payment row has non-string ${JSON.stringify(key)}; treating as missing`);
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Optional non-negative integer field: anything else becomes null. */
function paymentInt(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (value === undefined || value === null) return null;
  warn(`payment row has non-integer or negative ${JSON.stringify(key)}; treating as missing`);
  return null;
}

/**
 * Parse Tipalti's `displayedDate` (`Oct 27, 2026`) with an explicit English
 * month map — never `new Date(string)`, whose parsing shifts with locale and
 * timezone. Returns null for anything else (including impossible dates).
 */
export function parseTipaltiDate(value: unknown): DayParts | null {
  if (typeof value !== "string") return null;
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(value.trim());
  const m = ENGLISH_MONTHS[match?.[1]?.toLowerCase() ?? ""];
  if (!match || m === undefined) return null;
  const d = Number(match[2]);
  const y = Number(match[3]);
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/**
 * Parse `displayedAmountSubmitted` (`USD 3,141.59`) into its ISO code and
 * number. Thousands separators are stripped; anything else → null (the raw
 * text is always kept as `amountRaw` by the caller).
 */
export function parseTipaltiAmount(value: unknown): { currency: string; amount: number } | null {
  if (typeof value !== "string") return null;
  const match = /^\s*([A-Za-z]{3})\s+(-?[0-9,]*[0-9](?:\.[0-9]+)?)\s*$/.exec(value);
  const code = match?.[1];
  const digits = match?.[2];
  if (code === undefined || digits === undefined) return null;
  const amount = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  return { currency: code.toUpperCase(), amount };
}

/** Timeout error naming the Tipalti step that stalled (fixed strings only). */
function tipaltiTimeoutError(step: "panel" | "history", timeoutMs: number): Error {
  const what = step === "panel" ? "the payments panel" : "the payment history";
  return new Error(
    `Tipalti did not respond within ${formatBudget(timeoutMs)} while loading ${what}. ` +
      "Tipalti may be down or slow — try again later.",
  );
}

/**
 * One Tipalti request with the shared budget. Never attaches cookies or
 * reads the jar: isolation is structural, not a matter of remembering to
 * strip headers. An abort becomes the step's friendly timeout error;
 * anything else propagates untouched.
 */
async function tipaltiFetch(
  url: string,
  init: RequestInit,
  step: "panel" | "history",
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw tipaltiTimeoutError(step, timeoutMs);
    }
    throw error;
  }
}

/** Read a Tipalti body, mapping a stalled read to the same timeout error. */
async function readTipaltiBody(
  response: Response,
  step: "panel" | "history",
  timeoutMs: number,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw tipaltiTimeoutError(step, timeoutMs);
    }
    throw error;
  }
}

/**
 * Find the Tipalti payments-history iframe on the profile page. The `src`
 * values are HTML-escaped (`&amp;`), so they are unescaped before use.
 * Returns the validated absolute URL, or null when no suitable iframe
 * exists. Only exact host `ui2.tipalti.com` over https with the exact panel
 * path passes — a redirect or crafted `src` anywhere else is refused here
 * (and per-hop below) with an "unexpected origin" style error.
 */
export function extractPaymentsPanelUrl(html: string, baseUrl: string): string | null {
  const re = /<iframe[^>]*\bsrc="([^"]*)"[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const raw = (match[1] ?? "").replace(/&amp;/g, "&");
    let parsed: URL;
    try {
      parsed = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (isTipaltiUrl(parsed.href) && parsed.pathname === TIPALT_PANEL_PATH) {
      return parsed.href;
    }
  }
  return null;
}

/** Extract the API token from the panel page, or null when absent. */
function extractToken(html: string): string | null {
  return TIPALT_TOKEN_RE.exec(html)?.[1] ?? null;
}

/**
 * GET the Tipalti panel page, following redirects manually while they stay
 * on the Tipalti host. Never touches the cookie jar in either direction.
 */
async function fetchPanelHtml(url: string, timeoutMs: number): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_TIPALT_HOPS; hop++) {
    const response = await tipaltiFetch(
      current,
      { headers: { "User-Agent": "globo-mcp/0.1.0" }, redirect: "manual" },
      "panel",
      timeoutMs,
    );
    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      await response.arrayBuffer().catch(() => undefined);
      if (!location) {
        throw new Error("Could not load the payments panel. Tipalti may be down.");
      }
      const next = new URL(location, current);
      if (!isTipaltiUrl(next.toString())) {
        throw new Error(
          `Refusing to follow Tipalti redirect to unexpected origin ${JSON.stringify(next.origin)}.`,
        );
      }
      current = next.toString();
      continue;
    }
    if (response.status !== 200) {
      throw new Error(
        `Could not load the payments panel (HTTP ${response.status}). The portal or Tipalti may be down.`,
      );
    }
    return readTipaltiBody(response, "panel", timeoutMs);
  }
  throw new Error("Too many redirects (>10) while loading the payments panel.");
}

/**
 * POST the history API with the panel token (sent only to the Tipalti host).
 * Redirects are never followed (`redirect: "manual"`): a 3xx would otherwise
 * re-send the custom `authorizationtoken` header to the redirect target, so
 * it surfaces as a non-200 instead and fails closed downstream.
 */
async function postPaymentHistory(
  token: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const response = await tipaltiFetch(
    TIPALT_API_URL,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        authorizationtoken: token,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/plain, */*",
        "User-Agent": "globo-mcp/0.1.0",
      },
      body: TIPALT_HISTORY_BODY,
    },
    "history",
    timeoutMs,
  );
  return { status: response.status, text: await readTipaltiBody(response, "history", timeoutMs) };
}

/** Parse one history row; null (plus a warning) only when not an object. */
function parseRow(row: unknown): DatedPayment | null {
  if (!isRecord(row)) {
    warn("skipping malformed payment row (not an object)");
    return null;
  }
  const dateRaw = paymentText(row, "displayedDate");
  const date = dateRaw === null ? null : parseTipaltiDate(dateRaw);
  if (dateRaw !== null && date === null) {
    warn("payment row has an unparseable date; keeping it with date null");
  }
  const amountRaw = paymentText(row, "displayedAmountSubmitted");
  const parsedAmount = amountRaw === null ? null : parseTipaltiAmount(amountRaw);
  if (amountRaw !== null && parsedAmount === null) {
    warn("payment row has an unparseable amount; amount and currency will be null");
  }
  return {
    date: date ? formatDay(date) : null,
    amount: parsedAmount?.amount ?? null,
    currency: parsedAmount?.currency ?? null,
    amountRaw,
    status: paymentText(row, "status"),
    method: paymentText(row, "paymentMethod"),
    paymentId: paymentInt(row, "poId"),
    payer: paymentText(row, "payerEntityName"),
    reportAvailable: row["canDownloadPaymentDetailsReport"] === true,
    y: date?.y ?? null,
    m: date?.m ?? null,
    d: date?.d ?? null,
  };
}

/**
 * Parse the payment-history API body. Throws a friendly error on non-200 or
 * malformed payloads; skips bad rows with warnings.
 */
export function parsePaymentHistory(text: string, status: number): DatedPayment[] {
  if (status !== 200) {
    throw new Error(
      `Could not load the payment history (HTTP ${status}). The portal or Tipalti may be down.`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      "The payment history came back in an unexpected format. The portal or Tipalti may have changed.",
    );
  }
  if (!isRecord(payload) || !Array.isArray(payload["payeePaymentHistoryIFrameModels"])) {
    throw new Error(
      "The payment history came back in an unexpected format. The portal or Tipalti may have changed.",
    );
  }
  const rows: DatedPayment[] = [];
  for (const row of payload["payeePaymentHistoryIFrameModels"]) {
    const parsed = parseRow(row);
    if (parsed) rows.push(parsed);
  }
  // Compare what Tipalti sent, not what survived parsing: one skipped
  // malformed row must not emit a false "truncated" warning.
  const total = payload["totalNumberOfPayments"];
  if (typeof total === "number" && payload["payeePaymentHistoryIFrameModels"].length < total) {
    warn(
      `payment history truncated by Tipalti (${payload["payeePaymentHistoryIFrameModels"].length} of ${total} rows)`,
    );
  }
  return rows;
}

/**
 * Fetch (and cache) the parsed Tipalti payment list. `timeoutMs` is the
 * per-request budget (injectable so tests never wait out the real one).
 */
export async function fetchPayments(
  auth: PortalAuth,
  cache: TtlCache,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<DatedPayment[]> {
  const cached = cache.get<DatedPayment[]>(PAYMENTS_CACHE_KEY);
  if (cached) return cached;
  // The iframe URL and token are regenerated on every profile load, so both
  // are re-derived per refresh below — never cached, only the parsed list.
  for (let attempt = 0; attempt < 2; attempt++) {
    const profile = await auth.fetchWithAuth(PROFILE_PATH);
    if (profile.status !== 200) {
      throw new Error(
        `Could not load the profile page (HTTP ${profile.status}). The portal may be down.`,
      );
    }
    const panelUrl = extractPaymentsPanelUrl(profile.text, auth.client.baseUrl);
    if (panelUrl === null) {
      throw new Error(
        "Could not read the payments panel on the profile page. The portal may have changed.",
      );
    }
    const panelHtml = await fetchPanelHtml(panelUrl, timeoutMs);
    const token = extractToken(panelHtml);
    if (token === null) {
      throw new Error(
        "Could not read the payments panel on the profile page. The portal may have changed.",
      );
    }
    const api = await postPaymentHistory(token, timeoutMs);
    if ((api.status === 401 || api.status === 403) && attempt === 0) {
      // The token most likely expired mid-flight; re-derive it from a fresh
      // profile load exactly once.
      continue;
    }
    const rows = parsePaymentHistory(api.text, api.status);
    cache.set(PAYMENTS_CACHE_KEY, rows);
    return rows;
  }
  // Unreachable: every path above returns, retries once, or throws.
  throw new Error("Could not load the payment history. The portal or Tipalti may be down.");
}

/** Filters for `globo_payments`. Text matches are pre-lowercased. */
export interface PaymentFilter {
  start?: DayParts;
  end?: DayParts;
  /** Case-insensitive exact match on the portal status (`paid`, `rejected`). */
  status?: string;
  /** Case-insensitive exact match on the ISO currency code (`usd`). */
  currency?: string;
}

/** True when a payment survives the range and exact-match filters. */
export function matchesPayment(call: DatedPayment, filter: PaymentFilter): boolean {
  const parts = datedParts(call);
  if (parts !== null) {
    if (filter.start && dayKey(parts) < dayKey(filter.start)) return false;
    if (filter.end && dayKey(parts) > dayKey(filter.end)) return false;
  } else if (filter.start !== undefined || filter.end !== undefined) {
    // A range cannot be satisfied by an unknown date (same rule as the
    // other list tools).
    return false;
  }
  if (filter.status !== undefined && (call.status ?? "").toLowerCase() !== filter.status) {
    return false;
  }
  if (filter.currency !== undefined && (call.currency ?? "").toLowerCase() !== filter.currency) {
    return false;
  }
  return true;
}

/**
 * Newest first by date; rows with an unknown date sort last regardless, and
 * full ties keep Tipalti's order (stable sort — the response already arrives
 * newest-first, but that is not relied on).
 */
function compareNewestFirst(a: DatedPayment, b: DatedPayment): number {
  const ad = datedParts(a);
  const bd = datedParts(b);
  if (ad === null && bd === null) return 0;
  if (ad === null) return 1;
  if (bd === null) return -1;
  return dayKey(bd) - dayKey(ad);
}

/** Totals for `globo_payments`: per-currency sums plus per-status counts. */
export interface PaymentTotals {
  byCurrency: {
    currency: string;
    amount: number;
    count: number;
    /** Sum/count over rows with status `Paid` only (see below). */
    paidAmount: number;
    paidCount: number;
  }[];
  byStatus: { status: string; count: number }[];
}

/**
 * Totals over filtered rows. Currencies are never added together; `byStatus`
 * counts every row regardless of currency (rows without a parsed amount are
 * excluded from `byCurrency` only). `amount`/`count` cover every filtered
 * row including rejected payouts, so each entry also carries the `Paid`-only
 * `paidAmount`/`paidCount` for the "actually received" figure.
 */
export function totalPayments(calls: Payment[]): PaymentTotals {
  const byCurrency = new Map<
    string,
    { amount: number; count: number; paidAmount: number; paidCount: number }
  >();
  const byStatus = new Map<string, number>();
  for (const call of calls) {
    // Statuses are a controlled set (`Paid`/`Rejected`); anything else —
    // including a missing status — is counted, never dropped.
    const status = call.status ?? "Unknown";
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    if (call.currency !== null && call.amount !== null) {
      const entry = byCurrency.get(call.currency) ?? {
        amount: 0,
        count: 0,
        paidAmount: 0,
        paidCount: 0,
      };
      entry.amount += call.amount;
      entry.count += 1;
      if ((call.status ?? "").toLowerCase() === "paid") {
        entry.paidAmount += call.amount;
        entry.paidCount += 1;
      }
      byCurrency.set(call.currency, entry);
    }
  }
  return {
    byCurrency: [...byCurrency.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, entry]) => ({
        currency,
        amount: round2(entry.amount),
        count: entry.count,
        paidAmount: round2(entry.paidAmount),
        paidCount: entry.paidCount,
      })),
    byStatus: [...byStatus.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([status, count]) => ({ status, count })),
  };
}

/** Availability of one payout source as resolved by the tool (`note` carries the failure reason). */
export interface SourceAvailability {
  available: boolean;
  note?: string;
}

/** One source's block in the tool response. */
export interface SourceStatus extends SourceAvailability {
  count: number;
}

/** Fixed note: both sources are always checked; the two lists cover different records. */
const COMBINED_NOTE =
  "Checked both the Tipalti payout history and the portal payroll table. " +
  "Portal rows are per-method period summaries while Tipalti rows are individual payouts — " +
  "do not add them together. Totals cover the Tipalti rows only. " +
  "Tipalti dates are calendar dates as displayed; they carry no timezone.";

/** Paged list response for `globo_payments`. */
export interface PaymentList {
  total: number;
  returned: number;
  offset: number;
  /**
   * Always null, deliberately: Tipalti dates are displayed calendar dates
   * with no timezone, so no honest value exists. See `note`.
   */
  timezone: null;
  note: string;
  sources: { portal: SourceStatus; tipalti: SourceStatus };
  /** Totals over the filtered Tipalti rows only (never the portal summaries). */
  totals: PaymentTotals;
  payments: Payment[];
  /** Portal payroll rows: range-filtered, always complete, never paged. */
  portalPayments: PortalPayment[];
}

/** One-line reason from a settled rejection (fixed tool strings; never secrets). */
function rejectionReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Split settled source fetches into rows plus availability. Throws only when
 * both sources failed, so one source's failure never hides the other's data.
 */
export function settlePaymentSources(
  tipalti: PromiseSettledResult<DatedPayment[]>,
  portal: PromiseSettledResult<DatedPortalPayment[]>,
): {
  tipaltiRows: DatedPayment[];
  portalRows: DatedPortalPayment[];
  availability: { tipalti: SourceAvailability; portal: SourceAvailability };
} {
  if (tipalti.status === "rejected" && portal.status === "rejected") {
    throw new Error(
      `Could not load payments from either source (portal: ${rejectionReason(portal.reason)}; ` +
        `tipalti: ${rejectionReason(tipalti.reason)}).`,
    );
  }
  return {
    tipaltiRows: tipalti.status === "fulfilled" ? tipalti.value : [],
    portalRows: portal.status === "fulfilled" ? portal.value : [],
    availability: {
      tipalti:
        tipalti.status === "fulfilled"
          ? { available: true }
          : { available: false, note: rejectionReason(tipalti.reason) },
      portal:
        portal.status === "fulfilled"
          ? { available: true }
          : { available: false, note: rejectionReason(portal.reason) },
    },
  };
}

/**
 * Filter, order newest-first, then page the Tipalti rows; range-filter the
 * portal rows (always complete). Page bounds are validated by the caller.
 * Portal rows default to empty (Tipalti-only listings, as in unit tests).
 */
export function listPayments(
  calls: DatedPayment[],
  filter: PaymentFilter,
  limit: number,
  offset: number,
  portal: DatedPortalPayment[] = [],
  availability: { tipalti: SourceAvailability; portal: SourceAvailability } = {
    tipalti: { available: true },
    portal: { available: true },
  },
): PaymentList {
  const filtered = calls.filter((call) => matchesPayment(call, filter)).sort(compareNewestFirst);
  const page = filtered.slice(offset, offset + limit);
  const portalCalls = listPortalPayments(portal, { start: filter.start, end: filter.end });
  return {
    total: filtered.length,
    returned: page.length,
    offset,
    timezone: null,
    note: COMBINED_NOTE,
    sources: {
      portal: { ...availability.portal, count: portalCalls.length },
      tipalti: { ...availability.tipalti, count: filtered.length },
    },
    totals: totalPayments(filtered),
    payments: page.map((call) => ({
      date: call.date,
      amount: call.amount,
      currency: call.currency,
      amountRaw: call.amountRaw,
      status: call.status,
      method: call.method,
      paymentId: call.paymentId,
      payer: call.payer,
      reportAvailable: call.reportAvailable,
    })),
    portalPayments: portalCalls,
  };
}

// ---------------------------------------------------------------------------
// Portal payroll table (`/interpreter/payments_index`)
// ---------------------------------------------------------------------------
// Server-rendered single table inside `#payroll-vouchers-summary-content`
// (pagy pagination, no JSON twin — HTML scraping is the only path, as with
// `/scheduled_calls`). Each row is a per-method period summary, not an
// individual payout: never add these to the Tipalti rows. Detail links
// (`/interpreter/payment_index/<id>`) are stored, never fetched — those ids
// are per-payment records and guessing them would be a privacy violation.

const PORTAL_PAYMENTS_PATH = "/interpreter/payments_index";
/** Hard cap on pagy follows: a runaway `next` chain must not loop forever. */
const MAX_PORTAL_PAGES = 20;
/** Cache key for the portal rows (all pages concatenated). */
const PORTAL_PAYMENTS_CACHE_KEY = "portal:payments-index";

/** One portal payroll-voucher row for `globo_payments` output. */
export interface PortalPayment {
  method: string | null;
  /** Dates cell verbatim. */
  datesRaw: string;
  /** ISO period start/end; both null when the cell does not parse. */
  start: string | null;
  end: string | null;
  amount: number | null;
  /** ISO code when stated (`USD`); null for `$`/bare numbers (never guessed). */
  currency: string | null;
  /** Raw Total Amount cell (null when missing/empty). */
  amountRaw: string | null;
  /** Numeric id from the details href, when present. */
  paymentId: number | null;
  /**
   * Details href (`/interpreter/payment_index/<id>`) when present. Stored
   * only — never fetched.
   */
  detailsUrl: string | null;
}

/** Parsed portal row plus period endpoints (null when unparseable). */
export interface DatedPortalPayment extends PortalPayment {
  startParts: DayParts | null;
  endParts: DayParts | null;
}

/** Collapse whitespace, decode a few entities, and trim. */
function cleanPortal(raw: string): string {
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
function portalTextOf(rawHtml: string): string {
  return cleanPortal(rawHtml.replace(/<[^>]*>/g, " "));
}

/** Inner HTML of each `<td>` cell of a row, in order. */
function portalCellsOf(rowHtml: string): string[] {
  const cells: string[] = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rowHtml)) !== null) {
    cells.push(match[1] ?? "");
  }
  return cells;
}

/** Text cell: cleaned text, or null when empty. */
function portalTextCell(cell: string | undefined): string | null {
  if (cell === undefined) return null;
  const text = portalTextOf(cell);
  return text === "" ? null : text;
}

/**
 * Parse a Dates cell: either a single `MM/DD/YYYY` date (start and end are
 * the same day) or a `MM/DD/YYYY - MM/DD/YYYY` range. Both endpoints are
 * null unless the whole cell parses — a half-known period would mislead the
 * overlap filter below.
 */
function parsePortalPeriod(text: string): { start: DayParts | null; end: DayParts | null } {
  const trimmed = text.trim();
  if (trimmed === "") return { start: null, end: null };
  const parts = trimmed.split(/\s*-\s*/);
  if (parts.length === 1) {
    const single = parsePortalDate(parts[0]);
    return single ? { start: single, end: single } : { start: null, end: null };
  }
  if (parts.length === 2) {
    const start = parsePortalDate(parts[0]);
    const end = parsePortalDate(parts[1]);
    return start && end ? { start, end } : { start: null, end: null };
  }
  return { start: null, end: null };
}

/**
 * Parse a Total Amount cell (`$1,234.56`, `USD 1,234.56`, or a plain
 * number). A bare `$` or missing code yields an amount with null currency —
 * the code is never guessed. `N/A`/empty/unparseable → null (never throws).
 */
export function parsePortalAmount(
  value: unknown,
): { currency: string | null; amount: number } | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || /^n\/a$/i.test(text)) return null;
  const match = /^(?:([A-Za-z]{3})\s+)?\$?\s*(-?[0-9,]*[0-9](?:\.[0-9]+)?)$/.exec(text);
  const digits = match?.[2];
  if (match === null || digits === undefined) return null;
  const amount = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const code = match[1];
  return { currency: code === undefined ? null : code.toUpperCase(), amount };
}

/** Details link when the cell holds one, else null (stored, never fetched). */
function portalDetailsOf(cell: string | undefined): { url: string; id: number } | null {
  if (cell === undefined) return null;
  const href = /<a[^>]*href="([^"]*)"[^>]*>/i.exec(cell)?.[1]?.trim() ?? "";
  const id = /^\/interpreter\/payment_index\/(\d+)$/.exec(href)?.[1];
  if (id === undefined) return null;
  return { url: href, id: Number(id) };
}

/** Parse one portal table row; null (plus a warning) only when cells are missing. */
function parsePortalRow(cells: string[]): DatedPortalPayment | null {
  if (cells.length < 3) {
    warn("skipping portal payment row with missing cells");
    return null;
  }
  const datesRaw = portalTextOf(cells[1] ?? "");
  const period = parsePortalPeriod(datesRaw);
  if (datesRaw !== "" && (period.start === null || period.end === null)) {
    warn("portal payment row has an unparseable dates cell; keeping it dateless");
  }
  const amountRaw = portalTextCell(cells[2]);
  const parsedAmount = amountRaw === null ? null : parsePortalAmount(amountRaw);
  if (amountRaw !== null && parsedAmount === null) {
    warn("portal payment row has an unparseable amount; amount and currency will be null");
  }
  const details = portalDetailsOf(cells[3]);
  return {
    method: portalTextCell(cells[0]),
    datesRaw,
    start: period.start ? formatDay(period.start) : null,
    end: period.end ? formatDay(period.end) : null,
    amount: parsedAmount?.amount ?? null,
    currency: parsedAmount?.currency ?? null,
    amountRaw,
    paymentId: details?.id ?? null,
    detailsUrl: details?.url ?? null,
    startParts: period.start,
    endParts: period.end,
  };
}

/**
 * Parse the portal payroll-voucher page. Throws a friendly error when the
 * section table is missing (the page changed); an empty `<tbody>` yields
 * zero rows.
 */
export function parsePortalPayments(html: string): DatedPortalPayment[] {
  const section = /<div[^>]*\bid\s*=\s*["']?payroll-vouchers-summary-content["']?[^>]*>/i.exec(
    html,
  );
  if (!section) {
    throw new Error("The portal payments table is missing. The portal may have changed.");
  }
  const table = /<table[^>]*>([\s\S]*?)<\/table>/i.exec(html.slice(section.index));
  if (!table?.[1]) {
    throw new Error("The portal payments table is missing. The portal may have changed.");
  }
  // Header rows hold `<th>` cells, so only `<tr>` rows with `<td>` cells are
  // data; extra cells are ignored positionally (method/dates/amount).
  const rows: DatedPortalPayment[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(table[1])) !== null) {
    const rowHtml = match[1] ?? "";
    if (!/<td[\s>]/.test(rowHtml)) continue;
    const parsed = parsePortalRow(portalCellsOf(rowHtml));
    if (parsed) rows.push(parsed);
  }
  return rows;
}

/**
 * Next-page href from the pagy nav, or null when `next` is disabled, empty,
 * or off-portal (fail closed with a warning — a foreign target is never
 * followed).
 */
function nextPageHref(html: string, baseUrl: string): string | null {
  const item = /<li[^>]*class="([^"]*\bnext\b[^"]*)"[^>]*>([\s\S]*?)<\/li>/i.exec(html);
  if (!item) return null;
  if (/\bdisabled\b/i.test(item[1] ?? "")) return null;
  const href = /<a[^>]*href="([^"]*)"[^>]*>/i.exec(item[2] ?? "")?.[1]?.trim();
  if (!href || href === "#") return null;
  try {
    const target = new URL(href, baseUrl);
    if (target.origin !== new URL(baseUrl).origin) {
      warn(`ignoring off-portal payments next link to ${JSON.stringify(target.origin)}`);
      return null;
    }
    return `${target.pathname}${target.search}`;
  } catch {
    warn("ignoring unparseable payments next link");
    return null;
  }
}

/** Fetch (and cache) all portal payroll-voucher rows, following pagy `next` up to a cap. */
export async function fetchPortalPayments(
  auth: PortalAuth,
  cache: TtlCache,
): Promise<DatedPortalPayment[]> {
  const cached = cache.get<DatedPortalPayment[]>(PORTAL_PAYMENTS_CACHE_KEY);
  if (cached) return cached;
  const rows: DatedPortalPayment[] = [];
  let path: string | null = PORTAL_PAYMENTS_PATH;
  for (let page = 0; page < MAX_PORTAL_PAGES && path !== null; page++) {
    const result = await auth.fetchWithAuth(path);
    if (result.status !== 200) {
      throw new Error(
        `Could not load the portal payments page (HTTP ${result.status}). The portal may be down.`,
      );
    }
    rows.push(...parsePortalPayments(result.text));
    path = nextPageHref(result.text, auth.client.baseUrl);
  }
  if (path !== null) {
    warn(
      `portal payments list exceeds ${MAX_PORTAL_PAGES} pages; showing the first ${MAX_PORTAL_PAGES}`,
    );
  }
  cache.set(PORTAL_PAYMENTS_CACHE_KEY, rows);
  return rows;
}

/** Range-only filter for portal rows (portal rows are otherwise unfiltered). */
export interface PortalPaymentRange {
  start?: DayParts;
  end?: DayParts;
}

/**
 * True when a portal row overlaps the requested range. Unparseable dates are
 * excluded from a range filter, as elsewhere.
 */
export function matchesPortalPayment(
  call: DatedPortalPayment,
  filter: PortalPaymentRange,
): boolean {
  if (filter.start === undefined && filter.end === undefined) return true;
  if (call.startParts === null || call.endParts === null) return false;
  // Overlap with possibly open ends: rowStart <= filterEnd && rowEnd >= filterStart.
  if (filter.end !== undefined && dayKey(call.startParts) > dayKey(filter.end)) return false;
  if (filter.start !== undefined && dayKey(call.endParts) < dayKey(filter.start)) return false;
  return true;
}

/** Newest first by period start; dateless rows last; ties keep page order (stable). */
function comparePortalNewestFirst(a: DatedPortalPayment, b: DatedPortalPayment): number {
  if (a.startParts === null && b.startParts === null) return 0;
  if (a.startParts === null) return 1;
  if (b.startParts === null) return -1;
  return dayKey(b.startParts) - dayKey(a.startParts);
}

/** Range-filter (overlap) and order newest-first; portal rows are never paged. */
export function listPortalPayments(
  calls: DatedPortalPayment[],
  filter: PortalPaymentRange,
): PortalPayment[] {
  return calls
    .filter((call) => matchesPortalPayment(call, filter))
    .sort(comparePortalNewestFirst)
    .map((call) => ({
      method: call.method,
      datesRaw: call.datesRaw,
      start: call.start,
      end: call.end,
      amount: call.amount,
      currency: call.currency,
      amountRaw: call.amountRaw,
      paymentId: call.paymentId,
      detailsUrl: call.detailsUrl,
    }));
}
