import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractAuthenticityToken, extractState } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { CookieJar, HttpClient, isLoggedOutRedirect, isLoginPageBody } from "../src/http.js";
import { checkPaging, MAX_PAGE } from "../src/paging.js";
import { parseProfile } from "../src/portal/profile.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

describe("extractAuthenticityToken", () => {
  it("finds the token on the logged-out interstitial page", () => {
    const token = extractAuthenticityToken(fixture("logged-out-home.html"));
    expect(token).toBe("TESTAUTHENTICITYTOKEN");
  });

  it("returns undefined when the page has no token", () => {
    expect(extractAuthenticityToken(fixture("login-identifier.html"))).toBeUndefined();
    expect(extractAuthenticityToken("<html><body>hi</body></html>")).toBeUndefined();
  });
});

describe("extractState", () => {
  it("finds the placeholder state on the identifier page", () => {
    expect(extractState(fixture("login-identifier.html"))).toBe("TESTSTATEVALUE");
  });

  it("finds the placeholder state on the password page", () => {
    expect(extractState(fixture("login-password.html"))).toBe("TESTSTATEVALUE");
  });

  it("returns undefined when the page has no state", () => {
    expect(extractState(fixture("logged-out-home.html"))).toBeUndefined();
  });
});

describe("isLoggedOutRedirect", () => {
  it("flags redirects to the Auth0 tenant", () => {
    expect(isLoggedOutRedirect("https://auth.globohq.cloud/authorize?x=1")).toBe(true);
  });

  it("ignores portal-local redirects and missing locations", () => {
    expect(isLoggedOutRedirect("https://globohq.com/users/edit")).toBe(false);
    expect(isLoggedOutRedirect("/u/login/identifier?state=x")).toBe(false);
    expect(isLoggedOutRedirect(null)).toBe(false);
  });
});

describe("isLoginPageBody", () => {
  it("flags the logged-out interstitial form", () => {
    expect(isLoginPageBody(fixture("logged-out-home.html"), "text/html; charset=utf-8")).toBe(true);
  });

  it("ignores signed-in pages and non-HTML bodies", () => {
    expect(isLoginPageBody(fixture("profile.html"), "text/html; charset=utf-8")).toBe(false);
    expect(isLoginPageBody(fixture("logged-out-home.html"), null)).toBe(false);
    expect(isLoginPageBody("{}", "application/json")).toBe(false);
  });
});

describe("CookieJar", () => {
  function responseWithCookies(setCookies: string[]): Response {
    const headers = new Headers();
    for (const c of setCookies) headers.append("set-cookie", c);
    return new Response("x", { headers });
  }

  it("sends cookies back to the host that set them, not elsewhere", () => {
    const jar = new CookieJar();
    jar.storeFromResponse(
      responseWithCookies(["_globo-portal_session=abc123; Path=/; HttpOnly"]),
      "https://globohq.com/",
    );
    expect(jar.headerFor("https://globohq.com/users/edit")).toContain(
      "_globo-portal_session=abc123",
    );
    expect(jar.headerFor("https://auth.globohq.cloud/authorize")).toBeUndefined();
  });

  it("keeps hosts isolated from each other", () => {
    const jar = new CookieJar();
    jar.storeFromResponse(
      responseWithCookies(["auth0=tenant-cookie; Path=/"]),
      "https://auth.globohq.cloud/x",
    );
    expect(jar.headerFor("https://auth.globohq.cloud/y")).toContain("auth0=tenant-cookie");
    expect(jar.headerFor("https://globohq.com/")).toBeUndefined();
  });
});

describe("loadConfig", () => {
  it("rejects a missing email with an actionable message", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/GLOBO_EMAIL/);
  });

  it("rejects missing credentials with an actionable message", () => {
    expect(() => loadConfig({ GLOBO_EMAIL: "a@b.c" } as NodeJS.ProcessEnv)).toThrow(
      /GLOBO_PASSWORD|GLOBO_SESSION_COOKIE/,
    );
  });

  it("accepts password auth and cookie auth", () => {
    const withPassword = loadConfig({
      GLOBO_EMAIL: "a@b.c",
      GLOBO_PASSWORD: "secret",
    } as NodeJS.ProcessEnv);
    expect(withPassword.password).toBe("secret");
    expect(withPassword.baseUrl).toBe("https://globohq.com");

    const withCookie = loadConfig({
      GLOBO_EMAIL: "a@b.c",
      GLOBO_SESSION_COOKIE: "raw-cookie",
    } as NodeJS.ProcessEnv);
    expect(withCookie.password).toBeUndefined();
    expect(withCookie.sessionCookie).toBe("raw-cookie");
  });

  it("rejects an invalid base URL", () => {
    expect(() =>
      loadConfig({
        GLOBO_EMAIL: "a@b.c",
        GLOBO_PASSWORD: "secret",
        GLOBO_BASE_URL: "not a url",
      } as NodeJS.ProcessEnv),
    ).toThrow(/GLOBO_BASE_URL/);
  });

  it("rejects non-HTTPS base URLs", () => {
    expect(() =>
      loadConfig({
        GLOBO_EMAIL: "a@b.c",
        GLOBO_PASSWORD: "secret",
        GLOBO_BASE_URL: "http://globohq.com",
      } as NodeJS.ProcessEnv),
    ).toThrow(/https/);
  });

  it("accepts a valid GLOBO_TIMEZONE", () => {
    const config = loadConfig({
      GLOBO_EMAIL: "a@b.c",
      GLOBO_PASSWORD: "secret",
      GLOBO_TIMEZONE: "Europe/Istanbul",
    } as NodeJS.ProcessEnv);
    expect(config.timezone).toBe("Europe/Istanbul");
  });

  it("rejects an invalid GLOBO_TIMEZONE with an actionable message", () => {
    expect(() =>
      loadConfig({
        GLOBO_EMAIL: "a@b.c",
        GLOBO_PASSWORD: "secret",
        GLOBO_TIMEZONE: "Bogus/Zone",
      } as NodeJS.ProcessEnv),
    ).toThrow(/GLOBO_TIMEZONE.*IANA/);
  });
});

describe("checkPaging", () => {
  it("accepts in-range paging", () => {
    expect(() => checkPaging(50, 0)).not.toThrow();
    expect(() => checkPaging(MAX_PAGE, 0, 0)).not.toThrow();
  });

  it("rejects out-of-range paging with an actionable message", () => {
    expect(() => checkPaging(-1, 0)).toThrow(/between 0 and 1000/);
    expect(() => checkPaging(MAX_PAGE + 1, 0)).toThrow(/between 0 and 1000/);
    expect(() => checkPaging(1.5, 0)).toThrow(/Invalid limit/);
    expect(() => checkPaging(10, -1)).toThrow(/Invalid offset/);
    expect(() => checkPaging(10, 0, -1)).toThrow(/Invalid min_minutes/);
  });
});

describe("parseProfile", () => {
  it("parses the anonymized profile fixture", () => {
    const profile = parseProfile(fixture("profile.html"));
    expect(profile).toEqual({
      name: "Test User",
      userId: "SH000",
      email: "user@example.com",
      timezone: "Europe/Istanbul",
      paymentMethod: "Tipalti - International",
      lastSignIn: expect.stringMatching(/\d{2}\/\d{2}\/\d{4}/),
    });
  });

  it("falls back to the time-zone select when the table row is absent", () => {
    const withoutRow = fixture("profile.html").replace(/<tr>\s*<td>\s*Time Zone[\s\S]*?<\/tr>/, "");
    expect(withoutRow).not.toMatch(/Time Zone\s*<strong/);
    expect(parseProfile(withoutRow).timezone).toBe("Europe/Istanbul");
  });

  it("ignores selected options from other selects (endpoint ids)", () => {
    const withoutRowOrTzSelect = fixture("profile.html")
      .replace(/<tr>\s*<td>\s*Time Zone[\s\S]*?<\/tr>/, "")
      .replace(/<select[^>]*name="profile\[user\]\[time_zone\]"[\s\S]*?<\/select>/, "");
    expect(withoutRowOrTzSelect).not.toMatch(/<select[^>]*time_zone/);
    // The page still has selected endpoint options; none of them is a zone.
    expect(withoutRowOrTzSelect).toMatch(/selected="selected" value="310001"/);
    expect(parseProfile(withoutRowOrTzSelect).timezone).toBeNull();
  });

  it("returns nulls instead of throwing on unknown markup", () => {
    expect(parseProfile("<html><body>nothing here</body></html>")).toEqual({
      name: null,
      userId: null,
      email: null,
      timezone: null,
      paymentMethod: null,
      lastSignIn: null,
    });
  });
});

describe("HttpClient redirect policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function redirectTo(location: string, status = 302): Response {
    return new Response("", { status, headers: { location } });
  }

  it("refuses redirects to hosts outside the portal and login provider", async () => {
    const client = new HttpClient("https://globohq.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => redirectTo("https://evil.example/x")),
    );
    await expect(client.get("/users/edit")).rejects.toThrow(/unexpected origin/);
  });

  it("refuses non-HTTP redirect targets", async () => {
    const client = new HttpClient("https://globohq.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => redirectTo("javascript:alert(1)")),
    );
    await expect(client.get("/users/edit")).rejects.toThrow(/non-HTTP/);
  });

  it("drops the POST body when crossing hosts, even on 307", async () => {
    const client = new HttpClient("https://globohq.com");
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          return redirectTo("https://auth.globohq.cloud/authorize?x=1", 307);
        }
        return new Response("done", { status: 200 });
      }),
    );
    const result = await client.postForm("https://globohq.com/omniauth/auth0", { a: "b" });
    expect(result.text).toBe("done");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init.method).toBe("GET");
    expect(calls[1]?.init.body).toBeUndefined();
  });

  it("preserves the POST body on same-host 307", async () => {
    const client = new HttpClient("https://globohq.com");
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          return redirectTo("https://globohq.com/other", 307);
        }
        return new Response("done", { status: 200 });
      }),
    );
    await client.postForm("https://globohq.com/omniauth/auth0", { a: "b" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init.method).toBe("POST");
    expect(calls[1]?.init.body).toContain("a=b");
  });

  it("maps a hung connection to a clear timeout error", async () => {
    const client = new HttpClient("https://globohq.com", 50);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation timed out.", "TimeoutError"));
            });
          }),
      ),
    );
    await expect(client.get("/users/edit")).rejects.toThrow(/did not respond within/);
  });

  it("times out requestOnce too, reading sub-second budgets in ms", async () => {
    const client = new HttpClient("https://globohq.com", 300);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation timed out.", "TimeoutError"));
            });
          }),
      ),
    );
    await expect(client.requestOnce("https://globohq.com/x")).rejects.toThrow(
      /did not respond within 300ms/,
    );
  });

  it("composes a caller-supplied signal with the timeout instead of discarding it", async () => {
    const client = new HttpClient("https://globohq.com", 30_000);
    let captured: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = init.signal ?? undefined;
        if (init.signal?.aborted) {
          throw new DOMException("This operation was aborted.", "AbortError");
        }
        return new Response("ok", { status: 200 });
      }),
    );
    const caller = new AbortController().signal;
    const result = await client.requestOnce("https://globohq.com/x", { signal: caller });
    expect(result.text).toBe("ok");
    expect(captured).toBeDefined();
    expect(captured).not.toBe(caller);
    expect(captured?.aborted).toBe(false);
    await expect(
      client.requestOnce("https://globohq.com/x", { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/cancelled before the portal responded/);
  });

  it("maps a stalled body read to the timeout error", async () => {
    const client = new HttpClient("https://globohq.com", 30_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = new Response("partial", { status: 200 });
        response.text = () =>
          Promise.reject(new DOMException("Body stalled mid-read.", "TimeoutError"));
        return response;
      }),
    );
    await expect(client.get("/users/edit")).rejects.toThrow(/did not respond within 30s/);
  });
});
