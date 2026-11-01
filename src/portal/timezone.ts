/**
 * Account timezone resolution.
 *
 * Portal dates are already rendered in the account's local timezone, so tools
 * never convert anything — but every analytics response echoes the timezone
 * so a model never has to guess which day boundary applies.
 */

import type { PortalAuth } from "../auth.js";
import { getProfile } from "./profile.js";

/** Per-session memo: the account never changes within a process. */
const memo = new WeakMap<PortalAuth, Promise<string>>();

/**
 * Resolve the account timezone: explicit override first (e.g.
 * `GLOBO_TIMEZONE`), then the profile page, finally `"UTC"` with a warning.
 */
export function getAccountTimezone(auth: PortalAuth, override?: string): Promise<string> {
  const cleaned = override?.trim();
  if (cleaned) return Promise.resolve(cleaned);
  let pending = memo.get(auth);
  if (!pending) {
    pending = getProfile(auth).then(
      (profile) => profile.timezone ?? warnFallback(),
      () => warnFallback(),
    );
    memo.set(auth, pending);
  }
  return pending;
}

function warnFallback(): string {
  console.error("[globo-mcp] warning: could not determine the account time zone; using UTC");
  return "UTC";
}
