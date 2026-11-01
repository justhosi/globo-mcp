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

/** Paged list response for `globo_payments`. */
export interface PaymentList {
  total: number;
  returned: number;
  offset: number;
  /** Payout source: always Tipalti (the portal page is empty for these accounts). */
  source: "tipalti";
  /**
   * Always null, deliberately: Tipalti dates are displayed calendar dates
   * with no timezone, so no honest value exists. See `note`.
   */
  timezone: null;
  note: string;
  totals: PaymentTotals;
  payments: Payment[];
}

/** Filter, order newest-first, then page. Page bounds are validated by the caller. */
export function listPayments(
  calls: DatedPayment[],
  filter: PaymentFilter,
  limit: number,
  offset: number,
): PaymentList {
  const filtered = calls.filter((call) => matchesPayment(call, filter)).sort(compareNewestFirst);
  const page = filtered.slice(offset, offset + limit);
  return {
    total: filtered.length,
    returned: page.length,
    offset,
    source: "tipalti",
    timezone: null,
    note: "Payment dates are calendar dates as Tipalti displays them; they carry no timezone.",
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
  };
}
