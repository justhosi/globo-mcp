import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PortalAuth } from "../src/auth.js";
import {
  bucketFor,
  buildBreakdown,
  fetchCallLog,
  filterCalls,
  formatDay,
  isoWeekBucket,
  listCalls,
  naiveMinutes,
  parseCallLog,
  parseDateInput,
  parsePortalDate,
  parsePortalTime,
  summarizeCalls,
  totalOf,
  type DatedCall,
} from "../src/portal/calls.js";
import { CACHE_TTL_MS, TtlCache } from "../src/portal/cache.js";
import { fetchMonthlyMinutes, normalizeMonth, parseMonthlyMinutes } from "../src/portal/monthly.js";
import { HttpClient } from "../src/http.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

function telCalls(): DatedCall[] {
  return parseCallLog(JSON.parse(fixture("calls-telephone.json")) as unknown);
}

function vidCalls(): DatedCall[] {
  return parseCallLog(JSON.parse(fixture("calls-video.json")) as unknown);
}

describe("parsePortalDate", () => {
  it("parses M/D/YYYY", () => {
    expect(parsePortalDate("10/27/2025")).toEqual({ y: 2025, m: 10, d: 27 });
    expect(parsePortalDate("1/5/2026")).toEqual({ y: 2026, m: 1, d: 5 });
    expect(formatDay({ y: 2026, m: 1, d: 5 })).toBe("2026-01-05");
  });

  it("rejects impossible dates and other formats", () => {
    expect(parsePortalDate("02/30/2025")).toBeNull();
    expect(parsePortalDate("02/29/2025")).toBeNull();
    expect(parsePortalDate("02/29/2024")).toEqual({ y: 2024, m: 2, d: 29 });
    expect(parsePortalDate("13/01/2025")).toBeNull();
    expect(parsePortalDate("2025-10-27")).toBeNull();
    expect(parsePortalDate("")).toBeNull();
    expect(parsePortalDate(null)).toBeNull();
    expect(parsePortalDate(42)).toBeNull();
  });
});

describe("parsePortalTime", () => {
  it("parses AM/PM times", () => {
    expect(parsePortalTime("09:31 PM")).toBe(21 * 60 + 31);
    expect(parsePortalTime("12:00 AM")).toBe(0);
    expect(parsePortalTime("12:00 PM")).toBe(12 * 60);
    expect(parsePortalTime("04:05 PM")).toBe(16 * 60 + 5);
  });

  it("rejects bad times", () => {
    expect(parsePortalTime("24:00 PM")).toBeNull();
    expect(parsePortalTime("09:31")).toBeNull();
    expect(parsePortalTime("")).toBeNull();
    expect(parsePortalTime(null)).toBeNull();
  });

  it("differences midnight crossings with +24h", () => {
    expect(naiveMinutes(23 * 60 + 57, 0)).toBe(3);
    expect(naiveMinutes(21 * 60 + 31, 21 * 60 + 43)).toBe(12);
    expect(naiveMinutes(100, 100)).toBe(0);
  });
});

describe("parseDateInput", () => {
  it("accepts YYYY-MM-DD and tolerates M/D/YYYY", () => {
    expect(parseDateInput("2026-09-30", "end")).toEqual({ y: 2026, m: 9, d: 30 });
    expect(parseDateInput("9/30/2026", "end")).toEqual({ y: 2026, m: 9, d: 30 });
  });

  it("rejects anything else, naming the accepted formats", () => {
    expect(() => parseDateInput("30.09.2026", "start")).toThrow(/YYYY-MM-DD.*MM\/DD\/YYYY/);
    expect(() => parseDateInput("2026-13-01", "start")).toThrow(/Invalid start/);
    expect(() => parseDateInput("", "end")).toThrow(/Invalid end/);
  });
});

describe("parseCallLog", () => {
  it("parses the telephone fixture with the hybrid duration rule", () => {
    const rows = telCalls();
    expect(rows).toHaveLength(8);
    // portalMinutes wins when nonzero...
    expect(rows[0]?.minutes).toBe(29);
    expect(rows[0]?.portalMinutes).toBe(29);
    // ...start/end differencing fills in for portalMinutes 0...
    expect(rows[1]?.minutes).toBe(12);
    expect(rows[1]?.portalMinutes).toBe(0);
    // ...including across midnight (naive == portal here).
    expect(rows[2]?.minutes).toBe(3);
    // zero-length call stays 0.
    expect(rows[3]?.minutes).toBe(0);
    // note passthrough.
    expect(rows[4]?.note).toBe("3 minutes of this call was serviced in the shift program");
    // hybrid prefers portalMinutes over the naive diff (3 vs 4).
    expect(rows[7]?.minutes).toBe(3);
    expect(rows[7]?.portalMinutes).toBe(3);
  });

  it("computes a midnight crossing from start/end when portalMinutes is 0", () => {
    const rows = parseCallLog({
      data: [
        {
          date: "11/05/2025",
          start: "11:57 PM",
          end: "12:05 AM",
          company: "Example Co",
          service: "Interpreting",
          call_unique_identifier: "a1b2c3d4e5",
          interpreter_minutes: 0,
          hourly_pay_units: "",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.minutes).toBe(8);
  });

  it("parses the video fixture (null ids stay null)", () => {
    const rows = vidCalls();
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.callId === null)).toBe(true);
    expect(rows[0]?.minutes).toBe(3);
    expect(rows[2]?.minutes).toBe(98);
  });

  it("throws a friendly error on a malformed envelope", () => {
    for (const bad of [42, null, {}, { data: "nope" }, []] as unknown[]) {
      expect(() => parseCallLog(bad)).toThrow(/unexpected format/);
    }
  });

  it("skips malformed rows without failing the whole payload", () => {
    const rows = parseCallLog({
      data: [
        {
          date: "10/28/2025",
          start: "04:05 PM",
          end: "04:34 PM",
          company: "Example Co",
          service: "Interpreting",
          call_unique_identifier: "a1b2c3d4e5",
          interpreter_minutes: 29,
          hourly_pay_units: "",
        },
        42,
        "nope",
        { date: "not a date", start: "x", end: "y" },
        { date: "10/28/2025", start: "bogus", end: "also bogus", interpreter_minutes: 0 },
      ],
    });
    // Last row survives with null minutes (bad time, portalMinutes 0).
    expect(rows).toHaveLength(2);
    expect(rows[1]?.minutes).toBeNull();
    expect(rows[1]?.date).toBe("2025-10-28");
  });
});

describe("filterCalls", () => {
  it("filters inclusively by range", () => {
    const rows = telCalls();
    const filtered = filterCalls(rows, {
      start: { y: 2025, m: 10, d: 28 },
      end: { y: 2025, m: 10, d: 28 },
    });
    expect(filtered.map((row) => row.date)).toEqual(["2025-10-28", "2025-10-28"]);
  });

  it("matches company/service case-insensitively", () => {
    const rows = telCalls();
    expect(filterCalls(rows, { company: "example" })).toHaveLength(1);
    expect(filterCalls(rows, { service: "audio line" })).toHaveLength(4);
    expect(filterCalls(rows, { company: "example", service: "audio" })).toHaveLength(0);
  });

  it("filters on the computed duration", () => {
    const rows = telCalls();
    expect(filterCalls(rows, { minMinutes: 30 }).map((row) => row.minutes)).toEqual([34]);
  });
});

describe("grouping", () => {
  it("buckets ISO weeks (Monday start, year boundary)", () => {
    expect(isoWeekBucket({ y: 2025, m: 10, d: 27 })).toBe("2025-W44");
    expect(isoWeekBucket({ y: 2025, m: 12, d: 31 })).toBe("2026-W01");
    expect(bucketFor(telCalls()[0], "day")).toBe("2025-10-28");
    expect(bucketFor(telCalls()[0], "month")).toBe("2025-10");
  });

  it("groups by month", () => {
    const rows = buildBreakdown(telCalls(), [], "month");
    expect(rows).toEqual([
      {
        bucket: "2025-10",
        telephone_calls: 3,
        telephone_minutes: 50,
        video_calls: 0,
        video_minutes: 0,
        total_minutes: 50,
      },
      {
        bucket: "2025-11",
        telephone_calls: 1,
        telephone_minutes: 3,
        video_calls: 0,
        video_minutes: 0,
        total_minutes: 3,
      },
      {
        bucket: "2026-02",
        telephone_calls: 1,
        telephone_minutes: 34,
        video_calls: 0,
        video_minutes: 0,
        total_minutes: 34,
      },
      {
        bucket: "2026-08",
        telephone_calls: 1,
        telephone_minutes: 0,
        video_calls: 0,
        video_minutes: 0,
        total_minutes: 0,
      },
      {
        bucket: "2026-09",
        telephone_calls: 2,
        telephone_minutes: 6,
        video_calls: 0,
        video_minutes: 0,
        total_minutes: 6,
      },
    ]);
  });

  it("groups by week and day", () => {
    const week = buildBreakdown(telCalls(), [], "week");
    expect(week[0]).toMatchObject({ bucket: "2025-W44", telephone_calls: 3 });
    const day = buildBreakdown(telCalls(), [], "day");
    expect(day.find((row) => row.bucket === "2025-10-28")).toMatchObject({
      telephone_calls: 2,
      telephone_minutes: 38,
    });
  });
});

describe("summarizeCalls and listCalls", () => {
  it("totals both logs with hours to 2dp", () => {
    const summary = summarizeCalls(telCalls(), vidCalls(), {
      timezone: "Europe/Istanbul",
      wantTelephone: true,
      wantVideo: true,
      groupBy: "none",
    });
    expect(summary.range).toEqual({ start: null, end: null, timezone: "Europe/Istanbul" });
    expect(summary.totals.telephone).toEqual({ calls: 8, minutes: 93, hours: 1.55 });
    expect(summary.totals.video).toEqual({ calls: 5, minutes: 155, hours: 2.58 });
    expect(summary.totals.combined).toEqual({ calls: 13, minutes: 248, hours: 4.13 });
    expect(summary.breakdown).toBeUndefined();
  });

  it("respects the type filter and range", () => {
    const summary = summarizeCalls(telCalls(), vidCalls(), {
      start: { y: 2026, m: 9, d: 1 },
      end: { y: 2026, m: 9, d: 30 },
      timezone: "Europe/Istanbul",
      wantTelephone: true,
      wantVideo: false,
      groupBy: "none",
    });
    expect(summary.range.start).toBe("2026-09-01");
    expect(summary.totals.telephone).toEqual({ calls: 2, minutes: 6, hours: 0.1 });
    expect(summary.totals.video).toEqual({ calls: 0, minutes: 0, hours: 0 });
  });

  it("returns an empty result cleanly", () => {
    const summary = summarizeCalls(telCalls(), vidCalls(), {
      start: { y: 2030, m: 1, d: 1 },
      timezone: "Europe/Istanbul",
      wantTelephone: true,
      wantVideo: true,
      groupBy: "month",
    });
    expect(summary.totals.combined).toEqual({ calls: 0, minutes: 0, hours: 0 });
    expect(summary.breakdown).toEqual([]);
    const list = listCalls(telCalls(), { company: "nobody" }, 50, 0);
    expect(list).toEqual({ total: 0, returned: 0, offset: 0, calls: [] });
  });

  it("paginates after filtering", () => {
    const page1 = listCalls(telCalls(), {}, 3, 0);
    expect(page1.total).toBe(8);
    expect(page1.returned).toBe(3);
    expect(page1.offset).toBe(0);
    expect(page1.calls).toHaveLength(3);
    const page3 = listCalls(telCalls(), {}, 3, 6);
    expect(page3.returned).toBe(2);
    expect(page3.calls[0]?.date).toBe("2026-02-19");
    expect(Object.keys(page3.calls[0] ?? {})).toEqual([
      "date",
      "start",
      "end",
      "company",
      "service",
      "callId",
      "minutes",
      "portalMinutes",
      "note",
    ]);
  });

  it("totalOf skips null minutes", () => {
    expect(totalOf([{ minutes: null, calls: 0 } as unknown as DatedCall])).toEqual({
      calls: 1,
      minutes: 0,
      hours: 0,
    });
  });
});

describe("monthly rollup", () => {
  it("normalizes '10 / 2025' to '2025-10'", () => {
    expect(normalizeMonth("10 / 2025")).toBe("2025-10");
    expect(normalizeMonth("01 / 2026")).toBe("2026-01");
    expect(normalizeMonth("13 / 2025")).toBeNull();
    expect(normalizeMonth("2025-10")).toBeNull();
    expect(normalizeMonth(null)).toBeNull();
  });

  it("parses and sorts the fixture ascending", () => {
    const months = parseMonthlyMinutes(JSON.parse(fixture("monthly-minutes.json")) as unknown);
    expect(months.map((m) => m.month)).toEqual(["2025-10", "2025-11", "2025-12", "2026-01"]);
    expect(months[0]).toEqual({ month: "2025-10", calls: 21, minutes: 376 });
  });

  it("throws on a malformed envelope, skips bad rows", () => {
    expect(() => parseMonthlyMinutes({})).toThrow(/unexpected format/);
    expect(
      parseMonthlyMinutes({
        data: [{ month: "10 / 2025", total_calls: 1, total_minutes: 2 }, 7, { nope: 1 }],
      }),
    ).toEqual([{ month: "2025-10", calls: 1, minutes: 2 }]);
  });
});

describe("TtlCache", () => {
  it("hits, misses, and expires on an injected clock", () => {
    let now = 1_000;
    const cache = new TtlCache(120_000, { now: () => now });
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", 42);
    expect(cache.get<number>("a")).toBe(42);
    now += CACHE_TTL_MS - 1;
    expect(cache.get<number>("a")).toBe(42);
    now += 1;
    expect(cache.get<number>("a")).toBeUndefined();
    cache.set("b", 1);
    cache.clear();
    expect(cache.get<number>("b")).toBeUndefined();
  });
});

describe("fetch caching", () => {
  function stubAuth(body: string): { auth: PortalAuth; gets: () => number } {
    const http = new HttpClient("https://globohq.com");
    let gets = 0;
    http.get = async (): Promise<{
      status: number;
      headers: Headers;
      text: string;
      url: string;
    }> => {
      gets += 1;
      return { status: 200, headers: new Headers(), text: body, url: "https://globohq.com/x" };
    };
    const auth = new PortalAuth(
      {
        email: "a@b.c",
        password: undefined,
        sessionCookie: "cookie",
        baseUrl: "https://globohq.com",
        timezone: undefined,
      },
      http,
    );
    return { auth, gets: () => gets };
  }

  it("fetches each log once and reuses the cache", async () => {
    const { auth, gets } = stubAuth(fixture("calls-telephone.json"));
    const cache = new TtlCache();
    await fetchCallLog(auth, cache, "telephone");
    await fetchCallLog(auth, cache, "telephone");
    await fetchCallLog(auth, cache, "video");
    expect(gets()).toBe(2);
  });

  it("refetches after TTL expiry", async () => {
    const { auth, gets } = stubAuth(fixture("calls-telephone.json"));
    let now = 0;
    const cache = new TtlCache(60_000, { now: () => now });
    await fetchCallLog(auth, cache, "telephone");
    now += 60_001;
    await fetchCallLog(auth, cache, "telephone");
    expect(gets()).toBe(2);
  });

  it("reports invalid JSON bodies with a friendly error", async () => {
    const { auth } = stubAuth("{oops");
    const cache = new TtlCache();
    await expect(fetchCallLog(auth, cache, "telephone")).rejects.toThrow(/unexpected format/);
    await expect(fetchMonthlyMinutes(auth, cache)).rejects.toThrow(/unexpected format/);
  });

  it("caches the monthly rollup too", async () => {
    const { auth, gets } = stubAuth(fixture("monthly-minutes.json"));
    const cache = new TtlCache();
    await fetchMonthlyMinutes(auth, cache);
    await fetchMonthlyMinutes(auth, cache);
    expect(gets()).toBe(1);
  });
});
