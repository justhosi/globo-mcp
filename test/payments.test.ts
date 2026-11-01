import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalAuth } from "../src/auth.js";
import { HttpClient } from "../src/http.js";
import { TtlCache } from "../src/portal/cache.js";
import {
  extractPaymentsPanelUrl,
  fetchPayments,
  listPayments,
  parsePaymentHistory,
  parseTipaltiAmount,
  parseTipaltiDate,
  totalPayments,
  type DatedPayment,
} from "../src/portal/payments.js";

const PORTAL_BASE = "https://globohq.com";
const PANEL_URL =
  "https://ui2.tipalti.com/PayeeDashboard/PaymentsHistory?payer=example&idap=00000000-0000-0000-0000-000000000000&ts=1000000000&hashkey=0123456789abcdef0123456789abcdef";
const API_URL = "https://ui2.tipalti.com/api/v0/PayeePaymentHistory/GetPayeePaymentHistory";
const TOKEN = "aaaaaaaa-1111-2222-3333-444455556666";
const API_BODY = '{"pagingData":{"PageCount":1,"PageSize":100}}';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

function history(): DatedPayment[] {
  return parsePaymentHistory(fixture("tipalti-history.json"), 200);
}

describe("extractPaymentsPanelUrl", () => {
  it("picks the PaymentsHistory iframe and unescapes its src", () => {
    expect(extractPaymentsPanelUrl(fixture("payments-profile.html"), PORTAL_BASE)).toBe(PANEL_URL);
  });

  it("returns null when no suitable iframe exists", () => {
    expect(extractPaymentsPanelUrl("<html><body>no iframes</body></html>", PORTAL_BASE)).toBeNull();
    const homeOnly = fixture("payments-profile.html").replace(/PaymentsHistory/g, "Home");
    expect(extractPaymentsPanelUrl(homeOnly, PORTAL_BASE)).toBeNull();
  });

  it("refuses off-host, wrong-path, and non-https iframe URLs", () => {
    const evil = `<iframe src="https://evil.example/PayeeDashboard/PaymentsHistory"></iframe>`;
    expect(extractPaymentsPanelUrl(evil, PORTAL_BASE)).toBeNull();
    const wrongPath = `<iframe src="https://ui2.tipalti.com/Other"></iframe>`;
    expect(extractPaymentsPanelUrl(wrongPath, PORTAL_BASE)).toBeNull();
    const plainHttp = `<iframe src="http://ui2.tipalti.com/PayeeDashboard/PaymentsHistory"></iframe>`;
    expect(extractPaymentsPanelUrl(plainHttp, PORTAL_BASE)).toBeNull();
  });
});

describe("parseTipaltiDate", () => {
  it("parses English month abbreviations without locale parsing", () => {
    expect(parseTipaltiDate("Oct 27, 2026")).toEqual({ y: 2026, m: 10, d: 27 });
    expect(parseTipaltiDate("September 5, 2026")).toEqual({ y: 2026, m: 9, d: 5 });
    expect(parseTipaltiDate("jan 1, 2026")).toEqual({ y: 2026, m: 1, d: 1 });
  });

  it("returns null for unknown months, impossible dates, and other shapes", () => {
    expect(parseTipaltiDate("Foo 1, 2026")).toBeNull();
    expect(parseTipaltiDate("Feb 30, 2026")).toBeNull();
    expect(parseTipaltiDate("2026-10-27")).toBeNull();
    expect(parseTipaltiDate("")).toBeNull();
    expect(parseTipaltiDate(null)).toBeNull();
  });
});

describe("parseTipaltiAmount", () => {
  it("parses code and amount, stripping thousands separators", () => {
    expect(parseTipaltiAmount("USD 3,141.59")).toEqual({ currency: "USD", amount: 3141.59 });
    expect(parseTipaltiAmount("EUR 250.00")).toEqual({ currency: "EUR", amount: 250 });
  });

  it("returns null for anything else", () => {
    expect(parseTipaltiAmount("lots of money")).toBeNull();
    expect(parseTipaltiAmount("USD")).toBeNull();
    expect(parseTipaltiAmount("USD ,")).toBeNull();
    expect(parseTipaltiAmount("")).toBeNull();
    expect(parseTipaltiAmount(null)).toBeNull();
  });
});

describe("parsePaymentHistory", () => {
  it("parses the fixture rows", () => {
    const rows = history();
    expect(rows).toHaveLength(6);
    expect(rows[2]).toMatchObject({
      date: "2026-10-27",
      amount: 3141.59,
      currency: "USD",
      amountRaw: "USD 3,141.59",
      status: "Paid",
      method: "Direct Deposit / ACH",
      paymentId: 910001,
      payer: "GLOBO",
      reportAvailable: true,
    });
    expect(rows[1]).toMatchObject({ status: "Rejected", reportAvailable: false });
  });

  it("keeps unparseable amounts and dates as nulls with raw text retained", () => {
    const rows = history();
    expect(rows[4]).toMatchObject({
      amount: null,
      currency: null,
      amountRaw: "lots of money",
      date: "2026-07-04",
    });
    expect(rows[5]).toMatchObject({ date: null, amount: 10, currency: "USD" });
  });

  it("throws a friendly error on non-200 and malformed envelopes", () => {
    expect(() => parsePaymentHistory("{}", 500)).toThrow(
      /Could not load the payment history \(HTTP 500\)/,
    );
    for (const bad of [
      42,
      null,
      {},
      { payeePaymentHistoryIFrameModels: "nope" },
      [],
    ] as unknown[]) {
      expect(() => parsePaymentHistory(JSON.stringify(bad), 200)).toThrow(/unexpected format/);
    }
    expect(() => parsePaymentHistory("{oops", 200)).toThrow(/unexpected format/);
  });

  it("returns zero rows for an empty model list", () => {
    expect(
      parsePaymentHistory(
        JSON.stringify({ totalNumberOfPayments: 0, payeePaymentHistoryIFrameModels: [] }),
        200,
      ),
    ).toEqual([]);
  });

  it("warns when Tipalti reports more rows than it sent", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      parsePaymentHistory(
        JSON.stringify({ totalNumberOfPayments: 10, payeePaymentHistoryIFrameModels: [] }),
        200,
      );
      expect(spy.mock.calls.flat().join("\n")).toMatch(/truncated by Tipalti \(0 of 10 rows\)/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("listPayments", () => {
  it("orders newest first (stable ties, dateless last) with source tipalti", () => {
    const list = listPayments(history(), {}, 100, 0);
    expect(list.total).toBe(6);
    expect(list.returned).toBe(6);
    expect(list.offset).toBe(0);
    expect(list.source).toBe("tipalti");
    expect(list.timezone).toBeNull();
    expect(list.note).toMatch(/no timezone/);
    expect(list.payments.map((payment) => payment.paymentId)).toEqual([
      910003, 910001, 910002, 910004, 910005, 910006,
    ]);
    expect(Object.keys(list.payments[0] ?? {})).toEqual([
      "date",
      "amount",
      "currency",
      "amountRaw",
      "status",
      "method",
      "paymentId",
      "payer",
      "reportAvailable",
    ]);
  });

  it("totals per currency without ever mixing them, counting every row by status", () => {
    expect(totalPayments(history())).toEqual({
      byCurrency: [
        { currency: "EUR", amount: 1450, count: 2, paidAmount: 1200, paidCount: 1 },
        { currency: "USD", amount: 3251.09, count: 3, paidAmount: 3251.09, paidCount: 3 },
      ],
      byStatus: [
        { status: "Paid", count: 5 },
        { status: "Rejected", count: 1 },
      ],
    });
  });

  it("matches status and currency exactly (pre-lowercased, as index.ts passes them)", () => {
    const rows = history();
    expect(listPayments(rows, { status: "paid" }, 100, 0).total).toBe(5);
    expect(listPayments(rows, { status: "rejected" }, 100, 0).total).toBe(1);
    expect(listPayments(rows, { status: "bogus" }, 100, 0)).toMatchObject({
      total: 0,
      returned: 0,
      payments: [],
    });
    expect(
      listPayments(rows, { currency: "eur" }, 100, 0).payments.map((payment) => payment.paymentId),
    ).toEqual([910002, 910004]);
  });

  it("filters inclusively by date range, excluding dateless rows", () => {
    const rows = history();
    const list = listPayments(
      rows,
      { start: { y: 2026, m: 9, d: 1 }, end: { y: 2026, m: 9, d: 30 } },
      100,
      0,
    );
    expect(list.payments.map((payment) => payment.paymentId)).toEqual([910002]);
    expect(listPayments(rows, { start: { y: 2020, m: 1, d: 1 } }, 100, 0).total).toBe(5);
  });

  it("pages with total reflecting all filtered rows", () => {
    const rows = history();
    const page = listPayments(rows, {}, 2, 0);
    expect(page.total).toBe(6);
    expect(page.returned).toBe(2);
    expect(page.totals.byStatus).toEqual([
      { status: "Paid", count: 5 },
      { status: "Rejected", count: 1 },
    ]);
    const tail = listPayments(rows, {}, 2, 4);
    expect(tail.returned).toBe(2);
    expect(tail.payments.map((payment) => payment.paymentId)).toEqual([910005, 910006]);
  });
});

describe("fetchPayments chain", () => {
  interface SeenCall {
    url: string;
    init: RequestInit;
  }

  function stubChain(options: {
    profile?: string;
    panel?: string | { status: number; text: string };
    api?: { status: number; text: string; location?: string }[];
  }): { auth: PortalAuth; seen: SeenCall[] } {
    const http = new HttpClient(PORTAL_BASE);
    const seen: SeenCall[] = [];
    const apiQueue = [...(options.api ?? [])];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const target = String(url);
        seen.push({ url: target, init });
        if (target === `${PORTAL_BASE}/users/edit`) {
          return new Response(options.profile ?? "", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (target.startsWith("https://ui2.tipalti.com/PayeeDashboard/")) {
          const panel = options.panel ?? "";
          if (typeof panel === "string") {
            return new Response(panel, { status: 200, headers: { "content-type": "text/html" } });
          }
          return new Response(panel.text, { status: panel.status });
        }
        if (target === API_URL) {
          const next = apiQueue.shift() ?? { status: 500, text: "" };
          const headers = new Headers({ "content-type": "application/json" });
          if (next.location !== undefined) headers.set("location", next.location);
          return new Response(next.text, { status: next.status, headers });
        }
        throw new Error(`unexpected fetch to ${target}`);
      }),
    );
    const auth = new PortalAuth(
      {
        email: "a@b.c",
        password: undefined,
        sessionCookie: "cookie",
        baseUrl: PORTAL_BASE,
        timezone: undefined,
      },
      http,
    );
    return { auth, seen };
  }

  function headersOf(call: SeenCall | undefined): Headers {
    return new Headers(call?.init.headers);
  }

  function apiBody(): { status: number; text: string } {
    return { status: 200, text: fixture("tipalti-history.json") };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("walks profile, panel, and API with exact URLs, headers, and body", async () => {
    const { auth, seen } = stubChain({
      profile: fixture("payments-profile.html"),
      panel: fixture("tipalti-panel.html"),
      api: [apiBody()],
    });
    const cache = new TtlCache();
    const rows = await fetchPayments(auth, cache);
    expect(rows).toHaveLength(6);

    const urls = seen.map((call) => call.url);
    expect(urls).toEqual([`${PORTAL_BASE}/users/edit`, PANEL_URL, API_URL]);

    const apiCall = seen[2];
    expect(apiCall?.init.method).toBe("POST");
    const apiHeaders = headersOf(apiCall);
    expect(apiHeaders.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(apiHeaders.get("authorizationtoken")).toBe(TOKEN);
    expect(apiHeaders.get("x-requested-with")).toBe("XMLHttpRequest");
    expect(apiHeaders.get("accept")).toBe("application/json, text/plain, */*");
    expect(apiCall?.init.body).toBe(API_BODY);

    // Second call is served from the cache: no further requests at all.
    const cached = await fetchPayments(auth, cache);
    expect(cached).toBe(rows);
    expect(seen).toHaveLength(3);
  });

  it("keeps portal cookies and the Tipalti token on their own sides", async () => {
    const { auth, seen } = stubChain({
      profile: fixture("payments-profile.html"),
      panel: fixture("tipalti-panel.html"),
      api: [apiBody()],
    });
    await fetchPayments(auth, new TtlCache());

    const portalHeaders = headersOf(seen[0]);
    expect(portalHeaders.get("cookie")).toContain("_globo-portal_session=cookie");
    expect(portalHeaders.get("authorizationtoken")).toBeNull();

    for (const call of seen.slice(1)) {
      expect(headersOf(call).get("cookie")).toBeNull();
    }
    expect(headersOf(seen[2]).get("authorizationtoken")).toBe(TOKEN);

    // The jar never learns any Tipalti host, so nothing can leak later either.
    expect(auth.client.jar.headerFor("https://ui2.tipalti.com/api/x")).toBeUndefined();
  });

  it("never leaks the token, hashkey, or ts in error messages", async () => {
    const { auth } = stubChain({ profile: "<html><body>redesigned</body></html>" });
    const error: unknown = await fetchPayments(auth, new TtlCache()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toBe(
      "Could not read the payments panel on the profile page. The portal may have changed.",
    );
    expect(message).not.toContain(TOKEN);
  });

  it("fails on a missing token, an off-host iframe, and a wrong-path iframe", async () => {
    const noToken = { auth: stubChain({ profile: fixture("payments-profile.html") }).auth };
    await expect(fetchPayments(noToken.auth, new TtlCache())).rejects.toThrow(
      /Could not read the payments panel/,
    );

    const evilProfile = `<iframe src="https://evil.example/PayeeDashboard/PaymentsHistory"></iframe>`;
    await expect(
      fetchPayments(stubChain({ profile: evilProfile }).auth, new TtlCache()),
    ).rejects.toThrow(/Could not read the payments panel/);

    const wrongPath = `<iframe src="https://ui2.tipalti.com/Other"></iframe>`;
    await expect(
      fetchPayments(stubChain({ profile: wrongPath }).auth, new TtlCache()),
    ).rejects.toThrow(/Could not read the payments panel/);

    const oddPort = `<iframe src="https://ui2.tipalti.com:8443/PayeeDashboard/PaymentsHistory"></iframe>`;
    await expect(
      fetchPayments(stubChain({ profile: oddPort }).auth, new TtlCache()),
    ).rejects.toThrow(/Could not read the payments panel/);
  });

  it("refuses a Tipalti redirect to another origin", async () => {
    const { auth } = stubChain({ profile: fixture("payments-profile.html") });
    // Swap the panel responder for a redirect off-host after stubbing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, _init: RequestInit) => {
        const target = String(url);
        if (target === `${PORTAL_BASE}/users/edit`) {
          return new Response(fixture("payments-profile.html"), {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("", { status: 302, headers: { location: "https://evil.example/x" } });
      }),
    );
    await expect(fetchPayments(auth, new TtlCache())).rejects.toThrow(
      /Refusing to follow Tipalti redirect to unexpected origin/,
    );
  });

  it("retries once from step 1 on token expiry, then fails", async () => {
    const { auth, seen } = stubChain({
      profile: fixture("payments-profile.html"),
      panel: fixture("tipalti-panel.html"),
      api: [{ status: 401, text: "" }, apiBody()],
    });
    const rows = await fetchPayments(auth, new TtlCache());
    expect(rows).toHaveLength(6);
    expect(seen.filter((call) => call.url.endsWith("/users/edit"))).toHaveLength(2);
    expect(seen.filter((call) => call.url === API_URL)).toHaveLength(2);

    const { auth: auth2, seen: seen2 } = stubChain({
      profile: fixture("payments-profile.html"),
      panel: fixture("tipalti-panel.html"),
      api: [
        { status: 403, text: "" },
        { status: 403, text: "" },
      ],
    });
    await expect(fetchPayments(auth2, new TtlCache())).rejects.toThrow(
      /Could not load the payment history \(HTTP 403\)/,
    );
    expect(seen2.filter((call) => call.url.endsWith("/users/edit"))).toHaveLength(2);
    expect(seen2.filter((call) => call.url === API_URL)).toHaveLength(2);
  });

  it("names the failing step without leaking the token", async () => {
    const panelDown = stubChain({
      profile: fixture("payments-profile.html"),
      panel: { status: 500, text: "bad gateway" },
      api: [apiBody()],
    });
    await expect(fetchPayments(panelDown.auth, new TtlCache())).rejects.toThrow(
      /Could not load the payments panel \(HTTP 500\)/,
    );

    const historyDown = stubChain({
      profile: fixture("payments-profile.html"),
      panel: fixture("tipalti-panel.html"),
      api: [{ status: 500, text: "bad gateway" }],
    });
    const error: unknown = await fetchPayments(historyDown.auth, new TtlCache()).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe(
      "Could not load the payment history (HTTP 500). The portal or Tipalti may be down.",
    );

    const notJson = stubChain({
      profile: fixture("payments-profile.html"),
      panel: fixture("tipalti-panel.html"),
      api: [{ status: 200, text: "{oops" }],
    });
    await expect(fetchPayments(notJson.auth, new TtlCache())).rejects.toThrow(/unexpected format/);
  });

  it("never follows the API POST onto a redirect target", async () => {
    const { auth, seen } = stubChain({
      profile: fixture("payments-profile.html"),
      panel: fixture("tipalti-panel.html"),
      api: [{ status: 307, text: "", location: "https://evil.example/x" }],
    });
    await expect(fetchPayments(auth, new TtlCache())).rejects.toThrow(
      /Could not load the payment history \(HTTP 307\)/,
    );
    // Behavioural proof, not just the error text: nothing evil was fetched,
    // and the token never left the constant Tipalti API URL.
    expect(seen.filter((call) => call.url.startsWith("https://evil.example"))).toHaveLength(0);
    for (const call of seen) {
      const tokenHeader = headersOf(call).get("authorizationtoken");
      if (call.url === API_URL) {
        expect(tokenHeader).toBe(TOKEN);
      } else {
        expect(tokenHeader).toBeNull();
      }
    }
    // The harness can observe the mechanism directly: manual redirect mode.
    const apiCall = seen.find((call) => call.url === API_URL);
    expect(apiCall?.init.redirect).toBe("manual");
  });

  it("times out a hung panel request within the injected budget", async () => {
    const http = new HttpClient(PORTAL_BASE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const target = String(url);
        if (target === `${PORTAL_BASE}/users/edit`) {
          return new Response(fixture("payments-profile.html"), {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation timed out.", "TimeoutError"));
          });
        });
      }),
    );
    const auth = new PortalAuth(
      {
        email: "a@b.c",
        password: undefined,
        sessionCookie: "cookie",
        baseUrl: PORTAL_BASE,
        timezone: undefined,
      },
      http,
    );
    await expect(fetchPayments(auth, new TtlCache(), 50)).rejects.toThrow(
      /Tipalti did not respond within 50ms while loading the payments panel/,
    );
  });
});
