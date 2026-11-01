#!/usr/bin/env node
/**
 * globo-mcp: unofficial MCP server (stdio) for the GLOBO Portal.
 *
 * Read-only analytics over the interpreter call logs, the per-user schedule,
 * and `globo_whoami`.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PortalAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { HttpClient } from "./http.js";
import {
  dayKey,
  fetchCallLog,
  listCalls,
  parseDateInput,
  summarizeCalls,
  type CallType,
} from "./portal/calls.js";
import { TtlCache } from "./portal/cache.js";
import { fetchMonthlyMinutes } from "./portal/monthly.js";
import { fetchScheduledCalls, listScheduledCalls } from "./portal/scheduled.js";
import { fetchAssignments, listAssignments } from "./portal/assignments.js";
import { getAccountTimezone } from "./portal/timezone.js";
import { getProfile } from "./portal/profile.js";
import { checkPaging } from "./paging.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as unknown as { version: string };

const dateRangeShape = {
  start: z
    .string()
    .optional()
    .describe(
      "Range start, YYYY-MM-DD (also accepts MM/DD/YYYY). Inclusive, omit for no lower bound.",
    ),
  end: z
    .string()
    .optional()
    .describe(
      "Range end, YYYY-MM-DD (also accepts MM/DD/YYYY). Inclusive, omit for no upper bound.",
    ),
};

/** Run a tool body, returning pretty JSON or an `isError` failure. */
async function runTool(body: () => Promise<unknown>) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await body(), null, 2) }],
    };
  } catch (error) {
    return {
      content: [
        { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
      ],
      isError: true,
    };
  }
}

function parseRange(start?: string, end?: string) {
  const startParts = start === undefined ? undefined : parseDateInput(start, "start");
  const endParts = end === undefined ? undefined : parseDateInput(end, "end");
  if (startParts && endParts && dayKey(startParts) > dayKey(endParts)) {
    throw new Error(
      `Invalid range: start ${JSON.stringify(start)} is after end ${JSON.stringify(end)}.`,
    );
  }
  return { startParts, endParts };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const auth = new PortalAuth(config, new HttpClient(config.baseUrl));
  const cache = new TtlCache();
  const server = new McpServer({ name: "globo-mcp", version: pkg.version });

  server.registerTool(
    "globo_whoami",
    {
      title: "Who am I",
      description:
        "Show who is signed in to the GLOBO Portal: name, user id, email, time zone, payment method, and last sign-in.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => runTool(() => getProfile(auth)),
  );

  server.registerTool(
    "globo_call_summary",
    {
      title: "Call summary",
      description:
        "Summarize interpreted calls (telephone/audio and video) over a date range: call counts, minutes and hours, optionally grouped by day, week or month. Use for 'how much did I work' questions. For individual call rows use globo_list_calls; for the portal's own audited monthly figures use globo_monthly_minutes.",
      inputSchema: z.object({
        ...dateRangeShape,
        type: z
          .enum(["telephone", "video", "all"])
          .default("all")
          .describe("Which log to summarize."),
        group_by: z
          .enum(["day", "week", "month", "none"])
          .default("none")
          .describe(
            "Bucket breakdown by day (YYYY-MM-DD), ISO week (YYYY-Www) or month (YYYY-MM).",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ start, end, type, group_by }) =>
      runTool(async () => {
        const { startParts, endParts } = parseRange(start, end);
        const wantTelephone = type !== "video";
        const wantVideo = type !== "telephone";
        const [telephone, video, timezone] = await Promise.all([
          wantTelephone ? fetchCallLog(auth, cache, "telephone" satisfies CallType) : [],
          wantVideo ? fetchCallLog(auth, cache, "video" satisfies CallType) : [],
          getAccountTimezone(auth, config.timezone),
        ]);
        return summarizeCalls(telephone, video, {
          start: startParts,
          end: endParts,
          timezone: timezone ?? "UTC",
          wantTelephone,
          wantVideo,
          groupBy: group_by,
        });
      }),
  );

  server.registerTool(
    "globo_list_calls",
    {
      title: "List calls",
      description:
        "List individual interpreted calls (telephone/audio or video) with date, start/end times, company, service and durations in minutes. Filter by date range, company or service name (case-insensitive substring), or a minimum duration; results are paginated. Use to inspect specific calls. For totals use globo_call_summary.",
      inputSchema: z.object({
        ...dateRangeShape,
        type: z.enum(["telephone", "video"]).default("telephone").describe("Which log to list."),
        company: z.string().optional().describe("Keep calls whose company contains this text."),
        service: z.string().optional().describe("Keep calls whose service contains this text."),
        min_minutes: z
          .number()
          .optional()
          .describe("Keep calls lasting at least this many minutes."),
        limit: z.number().int().default(50).describe("Max rows to return (max 1000)."),
        offset: z.number().int().default(0).describe("Rows to skip before returning."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ start, end, type, company, service, min_minutes, limit, offset }) =>
      runTool(async () => {
        const { startParts, endParts } = parseRange(start, end);
        checkPaging(limit, offset, min_minutes);
        const [rows, timezone] = await Promise.all([
          fetchCallLog(auth, cache, type),
          getAccountTimezone(auth, config.timezone),
        ]);
        return {
          ...listCalls(
            rows,
            {
              start: startParts,
              end: endParts,
              company: company?.toLowerCase(),
              service: service?.toLowerCase(),
              minMinutes: min_minutes,
            },
            limit,
            offset,
          ),
          timezone: timezone ?? "UTC",
        };
      }),
  );

  server.registerTool(
    "globo_monthly_minutes",
    {
      title: "Monthly minutes",
      description:
        "Show the portal's own audited monthly minutes rollup (post-audit official figures; they can differ slightly from recomputing the call log). Months are YYYY-MM, ascending. Use when billed or official monthly numbers are needed; use globo_call_summary for custom ranges or groupings.",
      inputSchema: z.object({ ...dateRangeShape }),
      annotations: { readOnlyHint: true },
    },
    async ({ start, end }) =>
      runTool(async () => {
        const { startParts, endParts } = parseRange(start, end);
        const from = startParts
          ? `${startParts.y}-${String(startParts.m).padStart(2, "0")}`
          : undefined;
        const to = endParts ? `${endParts.y}-${String(endParts.m).padStart(2, "0")}` : undefined;
        const [months, timezone] = await Promise.all([
          fetchMonthlyMinutes(auth, cache),
          getAccountTimezone(auth, config.timezone),
        ]);
        return {
          timezone: timezone ?? "UTC",
          months: months.filter(
            (m) => (from === undefined || m.month >= from) && (to === undefined || m.month <= to),
          ),
        };
      }),
  );

  server.registerTool(
    "globo_scheduled_calls",
    {
      title: "Scheduled calls",
      description:
        "Show scheduled interpreting appointments (upcoming and past) from the portal's per-user schedule: project number, type, company, language, date, time, status, and duration. Filter by status or type (case-insensitive exact match), company (substring), date range, or upcoming_only for what's next. Times are portal wall-clock with no stated timezone. For worked-call history use globo_list_calls; for totals use globo_call_summary.",
      inputSchema: z.object({
        ...dateRangeShape,
        status: z
          .string()
          .optional()
          .describe(
            "Keep appointments with this status (case-insensitive exact match: completed, scheduled, cancelled, ...). Unknown values match nothing.",
          ),
        type: z
          .string()
          .optional()
          .describe(
            "Keep appointments of this type (case-insensitive exact match: Telephone, Video, Other - Video, ...).",
          ),
        company: z
          .string()
          .optional()
          .describe("Keep appointments whose company contains this text."),
        upcoming_only: z
          .boolean()
          .default(false)
          .describe(
            "Keep only appointments scheduled strictly after now (compared in your account timezone); Completed/Cancelled rows are dropped unless status is given explicitly.",
          ),
        limit: z.number().int().default(100).describe("Max rows to return (max 1000)."),
        offset: z.number().int().default(0).describe("Rows to skip before returning."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ start, end, status, type, company, upcoming_only, limit, offset }) =>
      runTool(async () => {
        const { startParts, endParts } = parseRange(start, end);
        checkPaging(limit, offset);
        const [rows, timezone] = await Promise.all([
          fetchScheduledCalls(auth, cache),
          getAccountTimezone(auth, config.timezone),
        ]);
        return listScheduledCalls(
          rows,
          {
            start: startParts,
            end: endParts,
            status: status?.toLowerCase(),
            type: type?.toLowerCase(),
            company: company?.toLowerCase(),
            upcomingOnly: upcoming_only,
            timezone: timezone ?? undefined,
          },
          limit,
          offset,
        );
      }),
  );

  server.registerTool(
    "globo_assignments",
    {
      title: "Assignments",
      description:
        "List the interpreter's assignment history (separate from ordinary telephone/video calls): date, start/end times, company, service, call id, durations in minutes, and any informational note the portal attached. Filter by date range, company or service name (case-insensitive substring), or a minimum duration; results are paginated with totals over all filtered rows. For ordinary calls use globo_list_calls.",
      inputSchema: z.object({
        ...dateRangeShape,
        company: z
          .string()
          .optional()
          .describe("Keep assignments whose company contains this text."),
        service: z
          .string()
          .optional()
          .describe("Keep assignments whose service contains this text."),
        min_minutes: z
          .number()
          .optional()
          .describe("Keep assignments lasting at least this many minutes."),
        limit: z.number().int().default(50).describe("Max rows to return (max 1000)."),
        offset: z.number().int().default(0).describe("Rows to skip before returning."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ start, end, company, service, min_minutes, limit, offset }) =>
      runTool(async () => {
        const { startParts, endParts } = parseRange(start, end);
        checkPaging(limit, offset, min_minutes);
        const [rows, timezone] = await Promise.all([
          fetchAssignments(auth, cache),
          getAccountTimezone(auth, config.timezone),
        ]);
        return {
          ...listAssignments(
            rows,
            {
              start: startParts,
              end: endParts,
              company: company?.toLowerCase(),
              service: service?.toLowerCase(),
              minMinutes: min_minutes,
            },
            limit,
            offset,
          ),
          timezone: timezone ?? "UTC",
        };
      }),
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stderr only: stdout carries the JSON-RPC transport. Messages here are
  // ours (config/auth errors) and never contain credentials.
  console.error(`[globo-mcp] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
