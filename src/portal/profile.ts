/**
 * Current-user profile read from the server-rendered `/users/edit` page.
 *
 * Parsing is label-based and defensive: unexpected markup yields `null`
 * fields plus a stderr warning, never an exception.
 */

import type { PortalAuth } from "../auth.js";

/** Profile fields shown by `globo_whoami`. Missing fields are `null`. */
export interface UserProfile {
  name: string | null;
  userId: string | null;
  email: string | null;
  timezone: string | null;
  paymentMethod: string | null;
  lastSignIn: string | null;
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

/** First `<tag ...>...</tag>` capture, tolerant of attributes/whitespace. */
function firstTag(html: string, tag: "h2" | "h3" | "h4"): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  if (!match?.[1]) return null;
  const text = textOf(match[1]);
  return text === "" ? null : text;
}

/**
 * Capture the value shown next to a `<label>…Label…</label>`: the text of the
 * first `<div>`, `<label>` or `<strong>` that follows it.
 */
function afterLabel(html: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `<label[^>]*>\\s*${escaped}\\s*<\\/label>\\s*<(?:div|label|strong)[^>]*>([\\s\\S]*?)<\\/(?:div|label|strong)>`,
    "i",
  ).exec(html);
  if (!match?.[1]) return null;
  const text = textOf(match[1]);
  return text === "" ? null : text;
}

/** Capture `<td>Label <strong>value</strong></td>` rows (Last Sign In, Time Zone). */
function tableRow(html: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<td>\\s*${escaped}\\s*<strong[^>]*>([\\s\\S]*?)<\\/strong>`, "i").exec(
    html,
  );
  if (!match?.[1]) return null;
  const text = textOf(match[1]);
  return text === "" ? null : text;
}

function warn(field: string): void {
  console.error(`[globo-mcp] warning: could not parse profile field ${JSON.stringify(field)}`);
}

/**
 * Parse a profile from `/users/edit` HTML. Never throws; missing fields
 * become `null` with a stderr warning.
 */
export function parseProfile(html: string): UserProfile {
  // The name/email/id header trio lives inside the profile-info block; other
  // h2/h4 elements on the page (page title, JS templates) must not match.
  const infoBlock =
    /<div[^>]*class="[^"]*profile-info[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html);
  const headerHtml = infoBlock?.[1] ?? html;

  const name = firstTag(headerHtml, "h2");
  const headerEmail = firstTag(headerHtml, "h3");
  const headerId = firstTag(headerHtml, "h4");

  const email = headerEmail ?? afterLabel(html, "Email");
  const userId = headerId ?? afterLabel(html, "Interpreter id");

  const lastSignIn = tableRow(html, "Last Sign In");
  const timezone =
    tableRow(html, "Time Zone") ??
    (() => {
      // Anchored to the time-zone select: an unscoped "first selected option"
      // search could return an endpoint id from another select on the page.
      const select =
        /<select[^>]*name="profile\[user\]\[time_zone\]"[^>]*>([\s\S]*?)<\/select>/i.exec(html);
      if (!select?.[1]) return null;
      const selected = /<option[^>]*\bselected\b[^>]*>/i.exec(select[1]);
      if (!selected) return null;
      const value = /value="([^"]+)"/i.exec(selected[0])?.[1]?.trim();
      return value ? value : null;
    })();
  const paymentMethod = afterLabel(html, "Payment Method");

  const profile: UserProfile = { name, userId, email, timezone, paymentMethod, lastSignIn };
  for (const [field, value] of Object.entries(profile)) {
    if (value === null) warn(field);
  }
  return profile;
}

/**
 * Fetch `/users/edit` with the session and parse the profile.
 *
 * @param auth Authenticated session (handles login/refresh).
 * @throws When the page cannot be fetched (network/auth errors propagate).
 */
export async function getProfile(auth: PortalAuth): Promise<UserProfile> {
  const result = await auth.fetchWithAuth("/users/edit");
  if (result.status !== 200) {
    throw new Error(
      `Could not load the profile page (HTTP ${result.status}). The portal may be down.`,
    );
  }
  return parseProfile(result.text);
}
