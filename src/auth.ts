/**
 * Login for the GLOBO Portal via the Auth0 Universal Login form flow.
 *
 * The portal front door (`GET /` while logged out) serves a tiny interstitial
 * page containing a form that POSTs back to `/omniauth/auth0`, which bounces
 * through the Auth0 tenant (`auth.globohq.cloud`: authorize → identifier →
 * password → resume) and finally lands back on the portal, setting the
 * `_globo-portal_session` cookie. Every hop uses `redirect: "manual"` with an
 * explicit loop so `Set-Cookie` headers are collected at each step — with
 * automatic redirect following they would be lost.
 *
 * On success the session cookie lives in the shared {@link HttpClient} jar.
 * `fetchWithAuth` replays one login and retries the request once when a data
 * request discovers the session has expired.
 */

import type { GloboConfig } from "./config.js";
import { AUTH_HOST, type FetchResult, HttpClient, isPortalOrAuthUrl } from "./http.js";

const SESSION_COOKIE = "_globo-portal_session";
const MAX_HOPS = 10;

/** Friendly, credential-free error for authentication failures. */
export class GloboAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GloboAuthError";
  }
}

/**
 * Extract the Rails `authenticity_token` from the logged-out interstitial
 * page (`GET /`).
 *
 * @returns The token, or `undefined` when the page has none.
 */
export function extractAuthenticityToken(html: string): string | undefined {
  const match = /name="authenticity_token" value="([^"]+)"/.exec(html);
  return match?.[1];
}

/**
 * Extract the Auth0 `state` hidden input from an identifier/password page.
 *
 * @returns The state value, or `undefined` when the page has none.
 */
export function extractState(html: string): string | undefined {
  const match = /name="state" value="([^"]+)"/.exec(html);
  return match?.[1];
}

/** Look for a human-readable Auth0 error without ever dumping page HTML. */
function detectAuth0Problem(html: string): string | undefined {
  const lowered = html.toLowerCase();
  if (
    lowered.includes("wrong email or password") ||
    lowered.includes("wrong-email-or-password") ||
    lowered.includes("invalid user name or password")
  ) {
    return "Sign-in failed: wrong email or password. Check GLOBO_EMAIL and GLOBO_PASSWORD and try again.";
  }
  if (
    lowered.includes("verify your identity") ||
    lowered.includes("multi-factor") ||
    lowered.includes("multifactor") ||
    /\/u\/mfa-/.test(lowered)
  ) {
    return (
      "Sign-in needs multi-factor authentication (MFA), which globo-mcp cannot complete. " +
      "Sign in once in a browser, then set GLOBO_SESSION_COOKIE to the _globo-portal_session cookie value instead."
    );
  }
  return undefined;
}

/** Authenticated access to the portal: login flow plus one-retry fetching. */
export class PortalAuth {
  // Protected (not private) so tests can subclass and observe login attempts.
  protected loggedIn = false;
  /**
   * In-flight login promise. Data requests fan out (`Promise.all` in the
   * tools), so concurrent callers must share one Auth0 flow instead of
   * trampling each other's transaction cookies in the shared jar.
   */
  private loginInFlight: Promise<void> | undefined;

  constructor(
    private readonly config: GloboConfig,
    private readonly http: HttpClient = new HttpClient(config.baseUrl),
  ) {
    if (config.sessionCookie) {
      this.http.jar.setCookie(
        new URL(config.baseUrl).hostname,
        SESSION_COOKIE,
        config.sessionCookie,
      );
      this.loggedIn = true;
    }
  }

  /** Expose the underlying HTTP client for data requests in later slices. */
  get client(): HttpClient {
    return this.http;
  }

  /**
   * Sign in. With `GLOBO_SESSION_COOKIE` this is a no-op (the cookie is
   * already seeded); otherwise it runs the Auth0 form flow.
   *
   * Single-flight: when several callers sign in at once (a cold start fans
   * out parallel data requests), the first starts the flow and the rest await
   * the same promise, so all observe the same outcome and only one Auth0
   * transaction touches the shared cookie jar. The slot is cleared in a
   * `finally`, so a failed login can be retried by a later call.
   *
   * @throws GloboAuthError with a friendly message when sign-in fails.
   */
  async login(): Promise<void> {
    const running = this.loginInFlight;
    if (running) {
      await running;
      return;
    }
    // Created and stored synchronously (no await between), so a concurrent
    // caller can never slip past the check above and start a second flow.
    const attempt = this.performLogin();
    this.loginInFlight = attempt;
    try {
      await attempt;
    } finally {
      if (this.loginInFlight === attempt) {
        this.loginInFlight = undefined;
      }
    }
  }

  /**
   * The actual sign-in work behind {@link login}. Protected (not private) so
   * tests can subclass and observe or stub login attempts.
   *
   * @throws GloboAuthError with a friendly message when sign-in fails.
   */
  protected async performLogin(): Promise<void> {
    if (this.config.sessionCookie && !this.config.password) {
      // Cookie-only mode: nothing to submit; validity is proven by requests.
      this.loggedIn = true;
      return;
    }
    if (!this.config.password) {
      throw new GloboAuthError(
        "Cannot sign in: no password configured and no usable session. Set GLOBO_PASSWORD or a fresh GLOBO_SESSION_COOKIE.",
      );
    }
    await this.loginWithPassword(this.config.email, this.config.password);
    this.loggedIn = true;
  }

  /** Sign in unless a session is already cached. */
  async ensureSession(): Promise<void> {
    if (!this.loggedIn) {
      await this.login();
    }
  }

  /**
   * GET a portal path with a valid session, signing in first when needed. If
   * the response shows we are logged out, sign in ONCE and retry the request
   * once. When several callers hit an expired session at once, {@link login}
   * runs never two flows at once (a late caller joins the in-flight flow, or
   * runs its own right after); each caller still retries its own request
   * exactly once.
   */
  async fetchWithAuth(path: string): Promise<FetchResult> {
    await this.ensureSession();
    let result = await this.http.get(path);
    if (!this.http.isLoggedOut(result)) {
      return result;
    }
    if (this.config.sessionCookie && !this.config.password) {
      throw new GloboAuthError(
        "The GLOBO_SESSION_COOKIE session has expired. Sign in again in a browser and update GLOBO_SESSION_COOKIE.",
      );
    }
    this.loggedIn = false;
    await this.login();
    result = await this.http.get(path);
    if (this.http.isLoggedOut(result)) {
      throw new GloboAuthError(
        "Still signed out after signing in again. The portal may be down or the account may be locked.",
      );
    }
    return result;
  }

  /**
   * The verified Auth0 Universal Login form flow over plain HTTP:
   * `/` → `POST /omniauth/auth0` → authorize → identifier → password →
   * resume → portal. Ends with `_globo-portal_session` in the cookie jar.
   */
  private async loginWithPassword(email: string, password: string): Promise<void> {
    const base = this.config.baseUrl;

    // a. Logged-out front door: interstitial form with the authenticity token.
    const home = await this.http.requestOnce(new URL("/", base).toString());
    const token = extractAuthenticityToken(home.text);
    if (home.status !== 200 || !token) {
      // Maybe we are already signed in (e.g. a fresh cookie from a retry).
      if (home.status === 200 && !this.http.isLoggedOut(home)) {
        return;
      }
      throw new GloboAuthError(
        "Could not start sign-in: the portal front page did not offer a login form. The portal may be down.",
      );
    }

    // b. Submit the interstitial form → 302 to the Auth0 /authorize URL.
    const callback = await this.http.requestOnce(new URL("/omniauth/auth0", base).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: new URL("/", base).toString(),
      },
      body: new URLSearchParams({ authenticity_token: token }).toString(),
    });
    const authorizeUrl = callback.headers.get("location");
    if (!authorizeUrl || new URL(authorizeUrl).hostname.toLowerCase() !== AUTH_HOST) {
      throw new GloboAuthError(
        "Could not start sign-in: the portal did not redirect to its login provider. The portal may be down.",
      );
    }

    // c. Walk the authorize hops manually → identifier page (state in URL).
    const identifier = await this.followRedirects(authorizeUrl);
    const state = extractState(identifier.text);
    if (identifier.status !== 200 || !state) {
      throw new GloboAuthError(
        "Could not start sign-in: the login page did not load correctly. The login provider may be down.",
      );
    }

    // e. Identifier step: state + username + action (no password, no _csrf).
    const identifierPostUrl = new URL("/u/login/identifier", `https://${AUTH_HOST}`);
    identifierPostUrl.searchParams.set("state", state);
    const idPost = await this.http.requestOnce(identifierPostUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: identifier.url,
      },
      body: new URLSearchParams({ state, username: email, action: "default" }).toString(),
    });
    const passwordPageUrl = idPost.headers.get("location");
    if (!passwordPageUrl) {
      throw new GloboAuthError(
        detectAuth0Problem(idPost.text) ??
          "Sign-in failed at the email step. Check GLOBO_EMAIL and try again.",
      );
    }

    // f. Password page → fresh state.
    const passwordPage = await this.followRedirects(
      new URL(passwordPageUrl, identifier.url).toString(),
    );
    const pstate = extractState(passwordPage.text);
    if (passwordPage.status !== 200 || !pstate) {
      throw new GloboAuthError(
        "Could not continue sign-in: the password page did not load correctly. The login provider may be down.",
      );
    }

    // g. Password step → resume → portal, setting the session cookie.
    const passwordPostUrl = new URL("/u/login/password", `https://${AUTH_HOST}`);
    passwordPostUrl.searchParams.set("state", pstate);
    const pwPost = await this.http.requestOnce(passwordPostUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: passwordPage.url,
      },
      body: new URLSearchParams({
        state: pstate,
        username: email,
        password,
        action: "default",
      }).toString(),
    });
    const resumeUrl = pwPost.headers.get("location");
    if (!resumeUrl) {
      throw new GloboAuthError(
        detectAuth0Problem(pwPost.text) ??
          "Sign-in failed. Check GLOBO_EMAIL and GLOBO_PASSWORD and try again.",
      );
    }
    const finalPage = await this.followRedirects(new URL(resumeUrl, passwordPage.url).toString());
    const problem = detectAuth0Problem(finalPage.text);
    if (problem) {
      throw new GloboAuthError(problem);
    }
    const finalHost = new URL(finalPage.url).hostname.toLowerCase();
    const portalHost = new URL(base).hostname.toLowerCase();
    if (finalHost !== portalHost || this.http.isLoggedOut(finalPage)) {
      throw new GloboAuthError(
        "Sign-in did not finish: the login provider did not return a portal session. Check your credentials and try again.",
      );
    }
  }

  /**
   * Follow 3xx hops one by one (cookies collected per hop) until a page.
   * Enforces the same "never leave the portal and its login provider"
   * invariant as `HttpClient.request`.
   */
  private async followRedirects(startUrl: string): Promise<FetchResult> {
    const base = this.config.baseUrl;
    let current = startUrl;
    let last: FetchResult | undefined;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      if (!isPortalOrAuthUrl(current, base)) {
        throw new GloboAuthError(
          "Sign-in tried to leave the portal and its login provider. Aborting sign-in.",
        );
      }
      last = await this.http.requestOnce(current);
      const location = last.headers.get("location");
      if (last.status >= 300 && last.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return last;
    }
    if (!last) {
      throw new GloboAuthError("Sign-in failed while contacting the login provider.");
    }
    return last;
  }
}
