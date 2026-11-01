import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { HttpClient, isLoginPageBody, setCookieHeader } from "../src/http.js";
import {
  parseArticle,
  parseResourceCategory,
  parseResourceIndex,
} from "../src/portal/resources.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

describe("isLoginPageBody (bounded)", () => {
  it("keeps fixture verdicts", () => {
    expect(isLoginPageBody(fixture("logged-out-home.html"), "text/html; charset=utf-8")).toBe(true);
    expect(isLoginPageBody(fixture("profile.html"), "text/html; charset=utf-8")).toBe(false);
    expect(isLoginPageBody(fixture("logged-out-home.html"), null)).toBe(false);
    expect(isLoginPageBody("{}", "application/json")).toBe(false);
  });

  it("handles case, prefixes, multiline, empty and truncated tags", () => {
    expect(
      isLoginPageBody('<FORM ID="x" ACTION="https://example.com/OMNIAUTH/AUTH0">', "text/html"),
    ).toBe(true);
    expect(isLoginPageBody("<formx>", "text/html")).toBe(false);
    expect(
      isLoginPageBody('<form\n id="a"\n action="/omniauth/auth0"\n method="post">', "text/html"),
    ).toBe(true);
    expect(isLoginPageBody("", "text/html")).toBe(false);
    expect(isLoginPageBody('<form action="https://globohq.com/omniauth/auth', "text/html")).toBe(
      false,
    );
    expect(isLoginPageBody("<form", "text/html")).toBe(false);
  });

  it("cuts the field match at the tag end", () => {
    expect(isLoginPageBody('<form><div id="omniauth/auth0">', "text/html")).toBe(false);
    expect(isLoginPageBody('<form action="/omniauth/auth0">', "text/html")).toBe(true);
  });

  it("stays fast on a hostile unterminated form tag", () => {
    const hostile = '<form id="'.repeat(52_000);
    const start = Date.now();
    expect(isLoginPageBody(hostile, "text/html")).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("stays fast on hostile inputs", () => {
    const small = "<form".repeat(8000) + "x";
    const t0 = Date.now();
    expect(isLoginPageBody(small, "text/html")).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);

    const big = "<form".repeat(600_000) + "x";
    const t1 = Date.now();
    expect(isLoginPageBody(big, "text/html")).toBe(false);
    expect(Date.now() - t1).toBeLessThan(1500);
  });
});

describe("resource parsers (indexed div closes)", () => {
  it("parses fixtures exactly as before", () => {
    const index = parseResourceIndex(fixture("faq-sections.html"));
    expect(index.total).toBe(4);
    expect(index.categories.map((c) => c.name)).toEqual([
      "Riverdale Clinic Resources",
      "Harborview Women's Care",
      "Night Shift 2025 🌙",
      "Quiet Corner",
    ]);
    expect(index.categories[0]).toEqual({
      name: "Riverdale Clinic Resources",
      sectionId: 101,
      previewItems: [
        { title: "Checking in for your shift", slug: "riverdale-check-in" },
        { title: "Submitting your timesheet", slug: "riverdale-timesheet" },
        { title: "Escalating a call", slug: "riverdale-escalation" },
      ],
      previewCount: 3,
      hasMore: true,
      sectionUrl: "/faq_sections/101",
    });

    const detail = parseResourceCategory(fixture("faq-section.html"), 101);
    expect(detail.category).toEqual({ name: "Riverdale Clinic Resources", sectionId: 101 });
    expect(detail.total).toBe(3);
    expect(detail.groups.map((g) => g.name)).toEqual([null, "Getting Started"]);
    expect(detail.groups[1]).toEqual({
      name: "Getting Started",
      items: [
        {
          title: "Checking in for your shift",
          slug: "riverdale-check-in",
          description: "Badge, desk, and first call",
        },
        { title: "Submitting your timesheet", slug: "riverdale-timesheet", description: null },
      ],
    });

    const article = parseArticle(fixture("article.html"), "riverdale-check-in");
    expect(article.title).toBe("Checking In for Your Shift");
    expect(article.description).toBe("Badge in at the front desk before your first call.");
    expect(article.keywords).toEqual(["check-in", "urgent"]);
    expect(article.links).toEqual([
      { text: "the timesheet guide", url: "https://globohq.com/slug/riverdale-timesheet" },
      { text: "the section page", url: "https://globohq.com/faq_sections/101" },
    ]);
    expect(article.body).toContain("Nested two levels deep");
  });

  it("rejects many unclosed blocks quickly with the existing error", () => {
    const evil = '<div class="col-sm-6">'.repeat(8000);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const start = Date.now();
      expect(() => parseResourceIndex(evil)).toThrow(/without categories/);
      expect(Date.now() - start).toBeLessThan(1200);
    } finally {
      spy.mockRestore();
    }
  });

  it("skips many unclosed category rows quickly", () => {
    const evil =
      '<ol id="breadcrumbs_target"><li>Home</li><li>Cat</li></ol>' +
      '<div class="inline">'.repeat(8000);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const start = Date.now();
      const detail = parseResourceCategory(evil, 101);
      expect(detail.total).toBe(0);
      expect(detail.groups).toEqual([]);
      expect(Date.now() - start).toBeLessThan(1200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("loadConfig cookie and base-url guards", () => {
  it("accepts realistic cookie values", () => {
    for (const value of ["DUMMY-SESSION-COOKIE", "abcDEF123-_.~%2F%3D", "a".repeat(4096)]) {
      const config = loadConfig({
        GLOBO_EMAIL: "a@b.c",
        GLOBO_SESSION_COOKIE: value,
      } as NodeJS.ProcessEnv);
      expect(config.sessionCookie).toBe(value);
    }
  });

  it("rejects bad cookie values without echoing them", () => {
    const cases: Array<[string, string]> = [
      ["DUMMY-TRAILING", "DUMMY-TRAILING\n"],
      ["DUMMY-INTERIOR", "DUMMY-INTERIOR\nVALUE"],
      ["DUMMY-CRLF", "DUMMY-CRLF\r\nVALUE"],
      ["DUMMY-NUL", "DUMMY-NUL\0VALUE"],
      ["DUMMY-TAB", "DUMMY-TAB\tVALUE"],
      ["DUMMY-SPACE", "DUMMY-SPACE VALUE"],
      ["DUMMY-UNICODE", "DUMMY-UNICODE-é-VALUE"],
    ];
    for (const [marker, value] of cases) {
      let message = "";
      try {
        loadConfig({ GLOBO_EMAIL: "a@b.c", GLOBO_SESSION_COOKIE: value } as NodeJS.ProcessEnv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/GLOBO_SESSION_COOKIE/);
      expect(message).not.toContain(marker);
    }
  });

  it("rejects userinfo base URLs without echoing credentials", () => {
    for (const baseUrl of ["https://user:pw@globohq.com", "https://user@globohq.com"]) {
      let message = "";
      try {
        loadConfig({
          GLOBO_EMAIL: "a@b.c",
          GLOBO_PASSWORD: "secret",
          GLOBO_BASE_URL: baseUrl,
        } as NodeJS.ProcessEnv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/GLOBO_BASE_URL/);
      expect(message).toMatch(/https:\/\/globohq\.com/);
      expect(message).not.toContain(baseUrl);
      expect(message).not.toContain("user:pw");
      expect(message).not.toContain("user@");
    }
    for (const baseUrl of [
      "https://DUMMYUSER:DUMMYPW@globohq.com",
      "https://DUMMYUSER@globohq.com",
    ]) {
      let message = "";
      try {
        loadConfig({
          GLOBO_EMAIL: "a@b.c",
          GLOBO_PASSWORD: "secret",
          GLOBO_BASE_URL: baseUrl,
        } as NodeJS.ProcessEnv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/GLOBO_BASE_URL/);
      expect(message).toMatch(/https:\/\/globohq\.com/);
      expect(message).not.toContain("DUMMYUSER");
      expect(message).not.toContain("DUMMYPW");
    }
    const ok = loadConfig({
      GLOBO_EMAIL: "a@b.c",
      GLOBO_PASSWORD: "secret",
      GLOBO_BASE_URL: "https://globohq.com",
    } as NodeJS.ProcessEnv);
    expect(ok.baseUrl).toBe("https://globohq.com");
  });

  it("rejects userinfo on http and unparseable values without echoing credentials", () => {
    for (const baseUrl of [
      "http://user:DUMMY-BASE-PASSWORD@globohq.com",
      "https://user:DUMMY-BASE-PASSWORD@globohq.com:99999",
    ]) {
      let message = "";
      try {
        loadConfig({
          GLOBO_EMAIL: "a@b.c",
          GLOBO_PASSWORD: "secret",
          GLOBO_BASE_URL: baseUrl,
        } as NodeJS.ProcessEnv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/GLOBO_BASE_URL/);
      expect(message).not.toContain("DUMMY-BASE-PASSWORD");
      expect(message).not.toContain(baseUrl);
    }
  });
});

describe("cookie header wrapper", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps an invalid header value to the fixed message", () => {
    const bad = "DUMMY-BAD\nVALUE";
    let message = "";
    try {
      setCookieHeader(new Headers(), bad);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not a valid HTTP header value/);
    expect(message).toMatch(/GLOBO_SESSION_COOKIE/);
    expect(message).not.toContain("DUMMY-BAD");
  });

  it("surfaces the fixed message through HttpClient without leaking the cookie", async () => {
    const client = new HttpClient("https://globohq.com");
    client.jar.setCookie("globohq.com", "_globo-portal_session", "DUMMY-BAD\nVALUE");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const error = await client.requestOnce("https://globohq.com/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not a valid HTTP header value/);
    expect((error as Error).message).not.toContain("DUMMY-BAD");
  });
});
