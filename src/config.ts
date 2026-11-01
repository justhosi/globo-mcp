/**
 * Environment-based configuration for globo-mcp.
 *
 * `GLOBO_EMAIL` plus either `GLOBO_PASSWORD` or `GLOBO_SESSION_COOKIE` is
 * required. Credential values are never logged.
 */

/** Resolved runtime configuration. Password/session cookie stay in memory only. */
export interface GloboConfig {
  email: string;
  /** Portal password. Absent when `sessionCookie` is used instead. */
  password: string | undefined;
  /** Raw `_globo-portal_session` cookie value; skips the login form flow. */
  sessionCookie: string | undefined;
  baseUrl: string;
  timezone: string | undefined;
}

export const DEFAULT_BASE_URL = "https://globohq.com";

/**
 * Read and validate configuration from environment variables.
 *
 * @param env Environment mapping to read (defaults to `process.env`).
 * @returns Validated configuration.
 * @throws Error with an actionable message when required values are missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GloboConfig {
  const email = (env["GLOBO_EMAIL"] ?? "").trim();
  const passwordRaw = env["GLOBO_PASSWORD"] ?? "";
  const sessionCookieRaw = env["GLOBO_SESSION_COOKIE"] ?? "";
  const baseUrl =
    (env["GLOBO_BASE_URL"] ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  const timezoneRaw = env["GLOBO_TIMEZONE"] ?? "";
  const timezone = timezoneRaw.trim() === "" ? undefined : timezoneRaw.trim();

  if (email === "") {
    throw new Error(
      "Missing GLOBO_EMAIL. Set it to your GLOBO Portal login email, e.g. GLOBO_EMAIL=you@example.com",
    );
  }
  const password = passwordRaw === "" ? undefined : passwordRaw;
  const sessionCookie = sessionCookieRaw === "" ? undefined : sessionCookieRaw;
  if (password === undefined && sessionCookie === undefined) {
    throw new Error(
      "Missing credentials. Set GLOBO_PASSWORD, or set GLOBO_SESSION_COOKIE to the raw " +
        "_globo-portal_session cookie value to skip login.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(
      `Invalid GLOBO_BASE_URL ${JSON.stringify(baseUrl)}. It must be an absolute URL such as https://globohq.com.`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Invalid GLOBO_BASE_URL ${JSON.stringify(baseUrl)}. It must use https:// — ` +
        "the session cookie would travel in cleartext over http://.",
    );
  }

  return {
    email,
    password,
    sessionCookie,
    baseUrl: parsed.toString().replace(/\/+$/, ""),
    timezone,
  };
}
