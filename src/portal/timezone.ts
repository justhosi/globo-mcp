/**
 * Account timezone resolution.
 *
 * Portal dates are already rendered in the account's local timezone, so tools
 * never convert anything — but each analytics response echoes the zone, or
 * `null` plus a note when the page states none, so a model never has to
 * guess which day boundary applies.
 */

import type { PortalAuth } from "../auth.js";
import { isValidTimezone } from "../config.js";
import { getProfile } from "./profile.js";

/** Per-session memo: the account never changes within a process. */
const memo = new WeakMap<PortalAuth, Promise<string | null>>();

/**
 * Resolve the account timezone: explicit override first (e.g.
 * `GLOBO_TIMEZONE`), then the profile page, finally `null` with a warning.
 * A profile zone that is not a usable IANA name falls back the same way, so
 * callers never hand a bad value to `Intl`. Callers substitute `"UTC"` (or
 * note the fallback) themselves.
 */
export function getAccountTimezone(auth: PortalAuth, override?: string): Promise<string | null> {
  const cleaned = override?.trim();
  if (cleaned) return Promise.resolve(cleaned);
  let pending = memo.get(auth);
  if (!pending) {
    pending = getProfile(auth).then(
      (profile) =>
        profile.timezone === null || !isValidTimezone(profile.timezone)
          ? warnFallback(profile.timezone)
          : profile.timezone,
      () => warnFallback(),
    );
    memo.set(auth, pending);
  }
  return pending;
}

function warnFallback(invalid?: string | null): null {
  const reason =
    invalid === undefined || invalid === null
      ? "could not determine the account time zone"
      : `ignoring invalid account time zone ${JSON.stringify(invalid)}`;
  console.error(`[globo-mcp] warning: ${reason}; using UTC`);
  return null;
}
