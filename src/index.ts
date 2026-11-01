#!/usr/bin/env node
/**
 * globo-mcp: unofficial MCP server (stdio) for the GLOBO Portal.
 *
 * Read-only analytics over the interpreter call logs plus `globo_whoami`.
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
import { getAccountTimezone } from "./portal/timezone.js";
import { getProfile } from "./portal/profile.js";

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

function checkPaging(limit: number, offset: number, minMinutes?: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Invalid limit ${JSON.stringify(limit)}. Use a non-negative integer.`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid offset ${JSON.stringify(offset)}. Use a non-negative integer.`);
  }
  if (minMinutes !== undefined && !(minMinutes >= 0)) {
    throw new Error(
      `Invalid min_minutes ${JSON.stringify(minMinutes)}. Use a non-negative number of minutes.`,
    );
  }
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
          timezone,
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
        limit: z.number().int().default(50).describe("Max rows to return."),
        offset: z.number().int().default(0).describe("Rows to skip before returning."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ start, end, type, company, service, min_minutes, limit, offset }) =>
      runTool(async () => {
        const { startParts, endParts } = parseRange(start, end);
        checkPaging(limit, offset, min_minutes);
        const rows = await fetchCallLog(auth, cache, type);
        return listCalls(
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
        );
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
          timezone,
          months: months.filter(
            (m) => (from === undefined || m.month >= from) && (to === undefined || m.month <= to),
          ),
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
