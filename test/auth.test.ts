import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GloboAuthError, PortalAuth } from "../src/auth.js";
import { type FetchResult, HttpClient } from "../src/http.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

const BASE_URL = "https://globohq.com";

function htmlResult(text: string, url: string): FetchResult {
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    text,
    url,
  };
}

/** PortalAuth that counts logins instead of performing the network flow. */
class CountingAuth extends PortalAuth {
  loginCalls = 0;

  override async login(): Promise<void> {
    this.loginCalls += 1;
    this.loggedIn = true;
  }
}

function passwordConfig() {
  return {
    email: "user@example.com",
    password: "secret",
    sessionCookie: undefined,
    baseUrl: BASE_URL,
    timezone: undefined,
  };
}

describe("PortalAuth.fetchWithAuth", () => {
  it("re-logs in exactly once and retries once after a logged-out response", async () => {
    const http = new HttpClient(BASE_URL);
    const loggedOut = htmlResult(fixture("logged-out-home.html"), `${BASE_URL}/users/edit`);
    const ok = htmlResult("<html><body>signed in</body></html>", `${BASE_URL}/users/edit`);
    let gets = 0;
    http.get = async (): Promise<FetchResult> => {
      gets += 1;
      return gets === 1 ? loggedOut : ok;
    };

    const auth = new CountingAuth(passwordConfig(), http);
    await auth.ensureSession();
    expect(auth.loginCalls).toBe(1);

    const result = await auth.fetchWithAuth("/users/edit");
    expect(result).toBe(ok);
    expect(gets).toBe(2);
    expect(auth.loginCalls).toBe(2);
  });

  it("in cookie-only mode reports an expired session instead of retrying", async () => {
    const http = new HttpClient(BASE_URL);
    let gets = 0;
    http.get = async (): Promise<FetchResult> => {
      gets += 1;
      return htmlResult(fixture("logged-out-home.html"), `${BASE_URL}/users/edit`);
    };

    const auth = new PortalAuth(
      {
        email: "user@example.com",
        password: undefined,
        sessionCookie: "stale-cookie",
        baseUrl: BASE_URL,
        timezone: undefined,
      },
      http,
    );
    const error: unknown = await auth.fetchWithAuth("/users/edit").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GloboAuthError);
    expect((error as Error).message).toMatch(/expired/);
    expect(gets).toBe(1);
  });
});

describe("PortalAuth.login password flow (stubbed transport)", () => {
  it("maps a wrong-password Auth0 page to a friendly error with no HTML", async () => {
    const http = new HttpClient(BASE_URL);
    const queue: FetchResult[] = [
      // a. Logged-out front door with the interstitial form.
      htmlResult(fixture("logged-out-home.html"), `${BASE_URL}/`),
      // b. Interstitial POST → Auth0 authorize.
      {
        status: 302,
        headers: new Headers({ location: "https://auth.globohq.cloud/authorize?x=1" }),
        text: "",
        url: `${BASE_URL}/omniauth/auth0`,
      },
      // c. Authorize hops → identifier page.
      {
        status: 302,
        headers: new Headers({ location: "/u/login/identifier?state=AAA" }),
        text: "",
        url: "https://auth.globohq.cloud/authorize?x=1",
      },
      // d. Identifier page.
      htmlResult(
        fixture("login-identifier.html"),
        "https://auth.globohq.cloud/u/login/identifier?state=AAA",
      ),
      // e. Identifier POST → password page.
      {
        status: 302,
        headers: new Headers({ location: "/u/login/password?state=BBB" }),
        text: "",
        url: "https://auth.globohq.cloud/u/login/identifier?state=TESTSTATEVALUE",
      },
      // f. Password page.
      htmlResult(
        fixture("login-password.html"),
        "https://auth.globohq.cloud/u/login/password?state=BBB",
      ),
      // g. Password POST rejected: wrong password, no redirect.
      htmlResult(
        '<html><body><div class="error">Wrong email or password.</div></body></html>',
        "https://auth.globohq.cloud/u/login/password?state=TESTSTATEVALUE",
      ),
    ];
    const seen: string[] = [];
    http.requestOnce = async (url: string, init: RequestInit = {}): Promise<FetchResult> => {
      seen.push(`${(init.method ?? "GET").toUpperCase()} ${url}`);
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra request in login flow");
      return next;
    };

    const auth = new PortalAuth(passwordConfig(), http);
    const error: unknown = await auth.login().catch((e: unknown) => e);
    expect(seen).toHaveLength(7);
    expect(error).toBeInstanceOf(GloboAuthError);
    const message = (error as Error).message;
    expect(message).toMatch(/wrong email or password/i);
    expect(message).not.toContain("<");
  });
});
