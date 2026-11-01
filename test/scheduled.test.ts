import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PortalAuth } from "../src/auth.js";
import { HttpClient } from "../src/http.js";
import type { FetchResult } from "../src/http.js";
import { TtlCache } from "../src/portal/cache.js";
import {
  fetchScheduledCalls,
  listScheduledCalls,
  matchesScheduled,
  parseDurationMinutes,
  parseScheduledCalls,
  type DatedScheduledCall,
} from "../src/portal/scheduled.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

function scheduled(): DatedScheduledCall[] {
  return parseScheduledCalls(fixture("scheduled-calls.html"));
}

describe("parseDurationMinutes", () => {
  it("parses minute, hour-minute, and clock forms", () => {
    expect(parseDurationMinutes("40m")).toBe(40);
    expect(parseDurationMinutes("90m")).toBe(90);
    expect(parseDurationMinutes("1h 30m")).toBe(90);
    expect(parseDurationMinutes("1h")).toBe(60);
    expect(parseDurationMinutes("00:30")).toBe(30);
    expect(parseDurationMinutes("02:00")).toBe(120);
  });

  it("returns null for empty, N/A, and unparseable text", () => {
    expect(parseDurationMinutes(null)).toBeNull();
    expect(parseDurationMinutes("")).toBeNull();
    expect(parseDurationMinutes("   ")).toBeNull();
    expect(parseDurationMinutes("N/A")).toBeNull();
    expect(parseDurationMinutes("n/a")).toBeNull();
    expect(parseDurationMinutes("soon")).toBeNull();
    expect(parseDurationMinutes("1:2")).toBeNull();
  });
});

describe("parseScheduledCalls", () => {
  it("parses the fixture rows with raw strings kept", () => {
    const rows = scheduled();
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.projectNumber)).toEqual([
      "SVI2026000001",
      "SVI2026000002",
      "SVI2026000003",
      "SVI2026000004",
      "SVI2026000005",
      "SVI2026000006",
    ]);
    const completed = rows[1];
    expect(completed).toMatchObject({
      type: "Other - Video",
      company: "Example Co",
      language: "Farsi",
      date: "2026-02-25",
      time: "05:30 PM",
      status: "Completed",
      duration: "40m",
      durationMinutes: 40,
      detailsUrl: "/scheduled_calls/5902",
    });
  });

  it("covers every live status and empty durations", () => {
    const rows = scheduled();
    expect(rows.map((row) => row.status)).toEqual([
      "Cancelled",
      "Completed",
      "Scheduled",
      "Completed",
      "Unfulfilled",
      "Completed",
    ]);
    // Cancelled row: empty duration cell and whitespace-only actions.
    expect(rows[0]?.duration).toBeNull();
    expect(rows[0]?.durationMinutes).toBeNull();
    expect(rows[0]?.detailsUrl).toBeNull();
    // N/A duration stays raw but parses to null.
    expect(rows[4]?.duration).toBe("N/A");
    expect(rows[4]?.durationMinutes).toBeNull();
    // Clock-form duration.
    expect(rows[5]?.durationMinutes).toBe(120);
  });

  it("keeps garbage dates as date null with the raw text in dateRaw", () => {
    const rows = scheduled();
    expect(rows[4]).toMatchObject({
      projectNumber: "SVI2026000005",
      date: null,
      dateRaw: "not a date",
      time: "02:00 PM",
      status: "Unfulfilled",
    });
  });

  it("skips malformed rows without failing the whole page", () => {
    const rows = parseScheduledCalls(`<html><body><table id="table-calls"><tbody>
      <tr><td>SVI1</td><td>Video</td><td>Example Co</td><td>Farsi</td>
        <td>02/25/2026</td><td>05:30 PM</td><td>Completed</td><td>40m</td>
        <td></td></tr>
      <tr><td>only</td><td>two</td></tr>
      <tr><td>SVI2</td><td>Video</td><td>Example Co</td><td>Farsi</td>
        <td>garbage</td><td>05:30 PM</td><td>Completed</td><td>40m</td>
        <td></td></tr>
    </tbody></table></body></html>`);
    // The short row is skipped; the garbage-date row survives dateless.
    expect(rows.map((row) => row.projectNumber)).toEqual(["SVI1", "SVI2"]);
    expect(rows[1]).toMatchObject({ date: null, dateRaw: "garbage" });
  });

  it("returns zero rows for an empty tbody, and errors when the table is missing", () => {
    expect(
      parseScheduledCalls(
        '<html><body><table id="table-calls"><tbody></tbody></table></body></html>',
      ),
    ).toEqual([]);
    expect(() => parseScheduledCalls("<html><body>no table here</body></html>")).toThrow(
      /table is missing/,
    );
  });
});

describe("listScheduledCalls", () => {
  it("orders newest first with dateless rows last, and reports a null timezone", () => {
    const list = listScheduledCalls(scheduled(), {}, 100, 0);
    expect(list.total).toBe(6);
    expect(list.returned).toBe(6);
    expect(list.offset).toBe(0);
    expect(list.timezone).toBeNull();
    expect(list.note).toMatch(/no.*timezone/i);
    expect(list.note).not.toMatch(/unavailable/);
    expect(list.calls.map((call) => call.projectNumber)).toEqual([
      "SVI2026000003",
      "SVI2026000001",
      "SVI2026000002",
      "SVI2026000004",
      "SVI2026000006",
      "SVI2026000005",
    ]);
    expect(Object.keys(list.calls[0] ?? {})).toEqual([
      "projectNumber",
      "type",
      "company",
      "language",
      "date",
      "dateRaw",
      "time",
      "status",
      "duration",
      "durationMinutes",
      "detailsUrl",
    ]);
  });

  it("matches status and type exactly and company by substring", () => {
    // Filter text arrives pre-lowercased (index.ts lowercases, same as the
    // company/service filters in calls.ts).
    const rows = scheduled();
    expect(
      listScheduledCalls(rows, { status: "completed" }, 100, 0).calls.map(
        (call) => call.projectNumber,
      ),
    ).toEqual(["SVI2026000002", "SVI2026000004", "SVI2026000006"]);
    expect(listScheduledCalls(rows, { status: "bogus" }, 100, 0)).toMatchObject({
      total: 0,
      returned: 0,
      calls: [],
    });
    expect(
      listScheduledCalls(rows, { type: "telephone" }, 100, 0).calls.map(
        (call) => call.projectNumber,
      ),
    ).toEqual(["SVI2026000003", "SVI2026000006"]);
    expect(listScheduledCalls(rows, { type: "other - video" }, 100, 0).total).toBe(2);
    expect(
      listScheduledCalls(rows, { company: "fabrikam" }, 100, 0).calls.map(
        (call) => call.projectNumber,
      ),
    ).toEqual(["SVI2026000003", "SVI2026000005"]);
  });

  it("filters inclusively by date range", () => {
    const rows = scheduled();
    const list = listScheduledCalls(
      rows,
      { start: { y: 2026, m: 2, d: 25 }, end: { y: 2026, m: 2, d: 25 } },
      100,
      0,
    );
    expect(list.calls.map((call) => call.projectNumber)).toEqual(["SVI2026000002"]);
    expect(matchesScheduled(rows[0], { start: { y: 2027, m: 1, d: 1 } })).toBe(false);
  });

  it("excludes unknown dates from ranges and sorts them last", () => {
    const rows = scheduled();
    const ranged = listScheduledCalls(rows, { start: { y: 2025, m: 1, d: 1 } }, 100, 0);
    expect(ranged.total).toBe(5);
    expect(ranged.calls.some((call) => call.projectNumber === "SVI2026000005")).toBe(false);
    const rangedEnd = listScheduledCalls(rows, { end: { y: 2027, m: 1, d: 1 } }, 100, 0);
    expect(rangedEnd.total).toBe(5);
  });

  it("keeps only future rows for upcoming_only, dropping past-tense statuses", () => {
    const rows = scheduled();
    const now = new Date(Date.UTC(2026, 2, 1));
    const list = listScheduledCalls(
      rows,
      { upcomingOnly: true, timezone: "Europe/Istanbul", now },
      100,
      0,
    );
    // The dateless row is never upcoming, whatever its status.
    expect(list.calls.map((call) => call.projectNumber)).toEqual(["SVI2026000003"]);
  });

  it("treats the upcoming boundary as strictly after now", () => {
    const rows = scheduled();
    // Exactly the 04/02 09:00 AM wall-clock instant in UTC: that row drops
    // out, and the dateless row is never upcoming.
    const now = new Date(Date.UTC(2026, 3, 2, 9, 0));
    const list = listScheduledCalls(rows, { upcomingOnly: true, now }, 100, 0);
    expect(list.calls).toEqual([]);
  });

  it("keeps future Completed rows when status is given explicitly", () => {
    const rows = scheduled();
    const now = new Date(Date.UTC(2026, 0, 1));
    const list = listScheduledCalls(rows, { status: "completed", upcomingOnly: true, now }, 100, 0);
    expect(list.calls.map((call) => call.projectNumber)).toEqual([
      "SVI2026000002",
      "SVI2026000004",
    ]);
  });

  it("paginates after filtering", () => {
    const rows = scheduled();
    const page1 = listScheduledCalls(rows, {}, 2, 0);
    expect(page1.total).toBe(6);
    expect(page1.returned).toBe(2);
    const page2 = listScheduledCalls(rows, {}, 2, 2);
    expect(page2.returned).toBe(2);
    expect(page2.offset).toBe(2);
    expect(page2.calls.map((call) => call.projectNumber)).toEqual([
      "SVI2026000002",
      "SVI2026000004",
    ]);
  });

  function upcomingRows(): DatedScheduledCall[] {
    return parseScheduledCalls(`<html><body><table id="table-calls"><tbody>
      <tr><td>FUTURE</td><td>Video</td><td>Example Co</td><td>Farsi</td>
        <td>06/15/2026</td><td>03:10 PM</td><td>Scheduled</td><td></td><td></td></tr>
      <tr><td>PAST</td><td>Video</td><td>Example Co</td><td>Farsi</td>
        <td>06/15/2026</td><td>02:50 PM</td><td>Scheduled</td><td></td><td></td></tr>
      <tr><td>MIDNIGHT</td><td>Video</td><td>Example Co</td><td>Farsi</td>
        <td>06/16/2026</td><td>12:10 AM</td><td>Scheduled</td><td></td><td></td></tr>
    </tbody></table></body></html>`);
  }

  it("compares upcoming against the account timezone, not UTC", () => {
    const rows = upcomingRows();
    // 12:00 UTC is 15:00 wall-clock in Europe/Istanbul (UTC+3, no DST):
    // 15:10 is upcoming, 14:50 is past.
    const now = new Date("2026-06-15T12:00:00Z");
    const list = listScheduledCalls(
      rows,
      { upcomingOnly: true, timezone: "Europe/Istanbul", now },
      100,
      0,
    );
    expect(list.calls.map((call) => call.projectNumber)).toEqual(["MIDNIGHT", "FUTURE"]);
    expect(list.note).not.toMatch(/unavailable/);
  });

  it("handles the midnight boundary in the account timezone", () => {
    const rows = upcomingRows();
    // 21:00 UTC is exactly 00:00 wall-clock in Europe/Istanbul: only the
    // 00:10 row is upcoming. (Midnight must format as 00:xx, never 24:xx.)
    const now = new Date("2026-06-15T21:00:00Z");
    const list = listScheduledCalls(
      rows,
      { upcomingOnly: true, timezone: "Europe/Istanbul", now },
      100,
      0,
    );
    expect(list.calls.map((call) => call.projectNumber)).toEqual(["MIDNIGHT"]);
  });

  it("falls back to UTC for upcoming when the timezone is unavailable", () => {
    const rows = upcomingRows();
    // 12:00 UTC wall-clock: both same-day rows are still ahead here, unlike
    // in Europe/Istanbul — proving the timezone is actually used above.
    const now = new Date("2026-06-15T12:00:00Z");
    const list = listScheduledCalls(rows, { upcomingOnly: true, now }, 100, 0);
    expect(list.calls.map((call) => call.projectNumber)).toEqual(["MIDNIGHT", "FUTURE", "PAST"]);
    expect(list.note).toMatch(/unavailable.*UTC/);
  });
});

describe("fetchScheduledCalls", () => {
  function stubAuth(body: string): { auth: PortalAuth; gets: () => number } {
    const http = new HttpClient("https://globohq.com");
    let gets = 0;
    http.get = async (): Promise<FetchResult> => {
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

  it("fetches once and reuses the cache", async () => {
    const { auth, gets } = stubAuth(fixture("scheduled-calls.html"));
    const cache = new TtlCache();
    const first = await fetchScheduledCalls(auth, cache);
    const second = await fetchScheduledCalls(auth, cache);
    expect(gets()).toBe(1);
    expect(second).toBe(first);
  });

  it("reports a missing table with a friendly error", async () => {
    const { auth } = stubAuth("<html><body>redesigned page</body></html>");
    await expect(fetchScheduledCalls(auth, new TtlCache())).rejects.toThrow(/table is missing/);
  });
});
