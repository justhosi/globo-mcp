/**
 * Minimal cookie-aware HTTP client built on the global `fetch`.
 *
 * Redirects are followed manually (`redirect: "manual"`, max 10 hops) so that
 * `Set-Cookie` headers are never lost along the Auth0 hop sequence. Cookies
 * are kept in a small in-memory jar keyed by host and are only ever sent back
 * to the host that set them (path/expiry handling is ignored — the portal
 * does not need it).
 */

const MAX_REDIRECTS = 10;
/** Host of the Auth0 tenant the portal delegates sign-in to. */
export const AUTH_HOST = "auth.globohq.cloud";

/** Final response of a request after following redirects. */
export interface FetchResult {
  /** HTTP status of the final response. */
  status: number;
  /** Headers of the final response. */
  headers: Headers;
  /** Body text of the final response. */
  text: string;
  /** URL of the final response (after redirects). */
  url: string;
}

/** In-memory cookie jar keyed by host. */
export class CookieJar {
  private readonly store = new Map<string, Map<string, string>>();

  /** Store cookies from a response's `Set-Cookie` headers under its host. */
  storeFromResponse(response: Response, url: string): void {
    const host = new URL(url).hostname.toLowerCase();
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length === 0) return;
    let hostCookies = this.store.get(host);
    if (!hostCookies) {
      hostCookies = new Map<string, string>();
      this.store.set(host, hostCookies);
    }
    for (const line of setCookies) {
      const pair = line.split(";", 1)[0];
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name === "") continue;
      if (value === "" || /^deleted$/i.test(value)) {
        hostCookies.delete(name);
      } else {
        hostCookies.set(name, value);
      }
    }
  }

  /** Seed a single cookie (used for `GLOBO_SESSION_COOKIE`). */
  setCookie(host: string, name: string, value: string): void {
    const key = host.toLowerCase();
    let hostCookies = this.store.get(key);
    if (!hostCookies) {
      hostCookies = new Map<string, string>();
      this.store.set(key, hostCookies);
    }
    hostCookies.set(name, value);
  }

  /** Build a `Cookie` header value for the given URL, if any cookies match. */
  headerFor(url: string): string | undefined {
    const hostCookies = this.store.get(new URL(url).hostname.toLowerCase());
    if (!hostCookies || hostCookies.size === 0) return undefined;
    return [...hostCookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** True when a URL points at the Auth0 tenant (never receives portal cookies). */
export function isAuthHostUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === AUTH_HOST;
  } catch {
    return false;
  }
}

/**
 * True when a redirect Location points at the Auth0 tenant, which means the
 * portal considers us logged out.
 */
export function isLoggedOutRedirect(location: string | null): boolean {
  if (!location) return false;
  return isAuthHostUrl(location);
}

/**
 * True when a 200 HTML body is actually the logged-out interstitial: a form
 * whose id or action contains `omniauth/auth0`.
 */
export function isLoginPageBody(text: string, contentType: string | null): boolean {
  if (!contentType || !contentType.toLowerCase().includes("text/html")) return false;
  return /<(form)[^>]*(id|action)="[^"]*omniauth\/auth0[^"]*"/i.test(text);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Cookie-aware fetch client bound to one portal base URL. */
export class HttpClient {
  readonly jar = new CookieJar();

  constructor(readonly baseUrl: string) {}

  /**
   * Fetch a URL, following redirects manually while accumulating cookies.
   * Never throws for HTTP error statuses; those are returned as results.
   */
  async request(url: string, init: RequestInit = {}): Promise<FetchResult> {
    let currentUrl = url;
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;

    const extraHeaders = new Headers(init.headers);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers = new Headers(extraHeaders);
      headers.set("User-Agent", "globo-mcp/0.1.0");
      const cookie = this.jar.headerFor(currentUrl);
      if (cookie) headers.set("Cookie", cookie);

      const response = await fetch(currentUrl, {
        ...init,
        method,
        body,
        headers,
        redirect: "manual",
      });
      this.jar.storeFromResponse(response, currentUrl);

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        await response.arrayBuffer().catch(() => undefined);
        if (!location) {
          return {
            status: response.status,
            headers: response.headers,
            text: "",
            url: currentUrl,
          };
        }
        const nextUrl = new URL(location, currentUrl);
        const nextHost = nextUrl.hostname.toLowerCase();
        const portalHost = new URL(this.baseUrl).hostname.toLowerCase();
        if (nextUrl.protocol !== "https:" && nextUrl.protocol !== "http:") {
          throw new Error(
            `Refusing to follow portal redirect to non-HTTP target on host ${JSON.stringify(nextHost)}.`,
          );
        }
        // Never leak this client off the portal / login-provider hosts.
        if (nextHost !== portalHost && nextHost !== AUTH_HOST) {
          throw new Error(
            `Refusing to follow portal redirect to unexpected host ${JSON.stringify(nextHost)}.`,
          );
        }
        const hostChanged = nextHost !== new URL(currentUrl).hostname.toLowerCase();
        currentUrl = nextUrl.toString();
        // Per fetch semantics: 303 always becomes GET; 301/302 turn POST into
        // GET. Additionally, always drop the body when crossing hosts so a
        // future POST (e.g. credentials) can never leak to another host, even
        // on 307/308 which otherwise preserve method and body.
        if (
          response.status === 303 ||
          hostChanged ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
          extraHeaders.delete("content-type");
          extraHeaders.delete("content-length");
        }
        continue;
      }

      const text = await response.text();
      return { status: response.status, headers: response.headers, text, url: currentUrl };
    }

    throw new Error(`Too many redirects (>${MAX_REDIRECTS}) while fetching the portal.`);
  }

  /**
   * Fetch a URL with `redirect: "manual"` and return immediately without
   * following redirects. Cookies are still stored. Used by the login flow,
   * which walks each hop explicitly.
   */
  async requestOnce(url: string, init: RequestInit = {}): Promise<FetchResult> {
    const headers = new Headers(init.headers);
    headers.set("User-Agent", "globo-mcp/0.1.0");
    const cookie = this.jar.headerFor(url);
    if (cookie) headers.set("Cookie", cookie);

    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    this.jar.storeFromResponse(response, url);
    // Redirect bodies are discarded; callers read the target from the
    // `location` response header.
    const text =
      isRedirect(response.status) || response.status === 204 ? "" : await response.text();
    return { status: response.status, headers: response.headers, text, url };
  }

  /** GET a same-portal path and return the final result. */
  get(path: string): Promise<FetchResult> {
    return this.request(new URL(path, this.baseUrl).toString());
  }

  /** POST URL-encoded form data and return the final result. */
  postForm(url: string, fields: Record<string, string>, referer?: string): Promise<FetchResult> {
    const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
    if (referer) headers.set("Referer", referer);
    return this.request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(fields).toString(),
    });
  }

  /**
   * Check whether a portal result means "logged out": either the final URL is
   * on the Auth0 host or the body is the logged-out interstitial form.
   */
  isLoggedOut(result: FetchResult): boolean {
    if (isAuthHostUrl(result.url)) return true;
    return isLoginPageBody(result.text, result.headers.get("content-type"));
  }
}
