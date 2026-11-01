import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PortalAuth } from "../src/auth.js";
import { HttpClient } from "../src/http.js";
import type { FetchResult } from "../src/http.js";
import { TtlCache } from "../src/portal/cache.js";
import {
  fetchAssignments,
  listAssignments,
  matchesAssignment,
  parseAssignmentLog,
  type DatedAssignment,
} from "../src/portal/assignments.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

function assignments(): DatedAssignment[] {
  return parseAssignmentLog(JSON.parse(fixture("assignments.json")) as unknown);
}

describe("parseAssignmentLog", () => {
  it("parses the fixture with the hybrid duration rule", () => {
    const rows = assignments();
    expect(rows).toHaveLength(7);
    // Fixture file order is chronological ascending, as the endpoint sends.
    expect(rows[0]?.callId).toBe("AR20260610007");
    const newest = rows[5];
    expect(newest).toMatchObject({
      date: "2026-06-30",
      start: "06:53 PM",
      end: "07:19 PM",
      company: "Example Co",
      service: "Assignments",
      callId: "AR20260630001",
      minutes: 25,
      portalMinutes: 25,
      note: null,
    });
  });

  it("keeps the free-text note verbatim and never sums it", () => {
    const rows = assignments();
    const noted = rows.find((row) => row.callId === "AR20260620004");
    expect(noted?.note).toBe("30 minutes of this call was serviced in the shift program");
    expect(noted?.minutes).toBe(30);
  });

  it("falls back to clock time on portalMinutes 0 and negative values", () => {
    const rows = assignments();
    const zero = rows.find((row) => row.callId === "AR20260625003");
    expect(zero?.minutes).toBe(19);
    expect(zero?.portalMinutes).toBe(0);
    const negative = rows.find((row) => row.callId === "AR20260615005");
    expect(negative?.minutes).toBe(30);
    expect(negative?.portalMinutes).toBeNull();
  });

  it("keeps unparseable dates as date null and null minutes when duration is unknowable", () => {
    const rows = assignments();
    const dateless = rows.find((row) => row.callId === "AR20260610006");
    expect(dateless?.date).toBeNull();
    expect(dateless?.minutes).toBe(50);
    const timeless = rows.find((row) => row.callId === "AR20260610007");
    expect(timeless?.date).toBe("2026-06-10");
    expect(timeless?.minutes).toBeNull();
  });

  it("throws a friendly error on a malformed envelope", () => {
    for (const bad of [42, null, {}, { data: "nope" }, []] as unknown[]) {
      expect(() => parseAssignmentLog(bad)).toThrow(/unexpected format/);
    }
  });

  it("skips malformed rows without failing the whole payload", () => {
    const rows = parseAssignmentLog({
      recordsTotal: 3,
      recordsFiltered: 3,
      data: [
        {
          date: "06/30/2026",
          start: "06:53 PM",
          end: "07:19 PM",
          company: "Example Co",
          service: "Assignments",
          call_unique_identifier: "AR20260630001",
          interpreter_minutes: 25,
          hourly_pay_units: "",
        },
        42,
        "nope",
      ],
    });
    expect(rows.map((row) => row.callId)).toEqual(["AR20260630001"]);
  });

  it("returns zero rows for an empty data array", () => {
    expect(parseAssignmentLog({ recordsTotal: 0, recordsFiltered: 0, data: [] })).toEqual([]);
  });
});

describe("listAssignments", () => {
  it("orders newest first with dateless rows last, and totals all filtered rows", () => {
    const list = listAssignments(assignments(), {}, 100, 0);
    expect(list.total).toBe(7);
    expect(list.returned).toBe(7);
    expect(list.offset).toBe(0);
    expect(list.totals).toEqual({ calls: 7, minutes: 201, hours: 3.35 });
    expect(list.calls.map((call) => call.callId)).toEqual([
      "AR20260630001",
      "AR20260628002",
      "AR20260625003",
      "AR20260620004",
      "AR20260615005",
      "AR20260610007",
      "AR20260610006",
    ]);
    expect(Object.keys(list.calls[0] ?? {})).toEqual([
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

  it("matches company and service case-insensitively", () => {
    const rows = assignments();
    expect(
      listAssignments(rows, { company: "fabrikam" }, 100, 0).calls.map((call) => call.callId),
    ).toEqual(["AR20260628002", "AR20260615005"]);
    expect(
      listAssignments(rows, { service: "video" }, 100, 0).calls.map((call) => call.callId),
    ).toEqual(["AR20260620004"]);
    expect(listAssignments(rows, { service: "onsite" }, 100, 0).total).toBe(1);
  });

  it("filters on the computed duration, excluding null minutes", () => {
    const rows = assignments();
    const list = listAssignments(rows, { minMinutes: 30 }, 100, 0);
    expect(list.calls.map((call) => call.minutes)).toEqual([47, 30, 30, 50]);
    expect(list.total).toBe(4);
  });

  it("totals the filtered rows, not just the returned page", () => {
    const rows = assignments();
    const filtered = listAssignments(rows, { company: "fabrikam" }, 100, 0);
    expect(filtered.totals).toEqual({ calls: 2, minutes: 77, hours: 1.28 });
    const page = listAssignments(rows, {}, 3, 0);
    expect(page.total).toBe(7);
    expect(page.returned).toBe(3);
    expect(page.totals).toEqual({ calls: 7, minutes: 201, hours: 3.35 });
    const tail = listAssignments(rows, {}, 3, 6);
    expect(tail.returned).toBe(1);
    expect(tail.calls[0]?.callId).toBe("AR20260610006");
  });

  it("excludes dateless rows from date ranges", () => {
    const rows = assignments();
    expect(matchesAssignment(rows[6], { start: { y: 2026, m: 1, d: 1 } })).toBe(false);
    expect(
      listAssignments(
        rows,
        { start: { y: 2026, m: 6, d: 20 }, end: { y: 2026, m: 6, d: 30 } },
        100,
        0,
      ).calls.map((call) => call.callId),
    ).toEqual(["AR20260630001", "AR20260628002", "AR20260625003", "AR20260620004"]);
  });
});

describe("fetchAssignments", () => {
  function stubAuth(body: string): { auth: PortalAuth; gets: () => number; paths: () => string[] } {
    const http = new HttpClient("https://globohq.com");
    let gets = 0;
    const paths: string[] = [];
    http.get = async (path: string): Promise<FetchResult> => {
      gets += 1;
      paths.push(path);
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
    return { auth, gets: () => gets, paths: () => paths };
  }

  it("calls the documented endpoint once and reuses the cache", async () => {
    const { auth, gets, paths } = stubAuth(fixture("assignments.json"));
    const cache = new TtlCache();
    const first = await fetchAssignments(auth, cache);
    const second = await fetchAssignments(auth, cache);
    expect(gets()).toBe(1);
    expect(second).toBe(first);
    expect(paths()).toEqual(["/interpreter/assignments_index_data?draw=1&start=0&length=10000"]);
  });

  it("reports a non-JSON body with a friendly error", async () => {
    const { auth } = stubAuth("{oops");
    await expect(fetchAssignments(auth, new TtlCache())).rejects.toThrow(/unexpected format/);
  });
});
