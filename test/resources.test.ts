import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PortalAuth } from "../src/auth.js";
import { HttpClient } from "../src/http.js";
import type { FetchResult } from "../src/http.js";
import { TtlCache } from "../src/portal/cache.js";
import {
  MAX_RESOURCE_LIST,
  fetchArticle,
  fetchResourceCategory,
  fetchResourceIndex,
  isValidSlug,
  listResourcePreviews,
  matchCategory,
  parseArticle,
  parseResourceCategory,
  parseResourceIndex,
  readProfilePayload,
  readResourcePayload,
  readResourcesPayload,
} from "../src/portal/resources.js";

const PORTAL_BASE = "https://globohq.com";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

function index() {
  return parseResourceIndex(fixture("faq-sections.html"));
}

describe("parseResourceIndex", () => {
  it("parses category blocks while ignoring the outer Resources titles", () => {
    const parsed = index();
    expect(parsed.total).toBe(4);
    expect(parsed.categories.map((c) => c.name)).toEqual([
      "Riverdale Clinic Resources",
      "Harborview Women's Care",
      "Night Shift 2025 🌙",
      "Quiet Corner",
    ]);
  });

  it("reads section ids, previews, and More links", () => {
    const parsed = index();
    expect(parsed.categories[0]).toMatchObject({
      sectionId: 101,
      previewCount: 3,
      hasMore: true,
      sectionUrl: "/faq_sections/101",
    });
    expect(parsed.categories[0]?.previewItems).toEqual([
      { title: "Checking in for your shift", slug: "riverdale-check-in" },
      { title: "Submitting your timesheet", slug: "riverdale-timesheet" },
      { title: "Escalating a call", slug: "riverdale-escalation" },
    ]);
  });

  it("keeps zero-item categories with their section link", () => {
    const parsed = index();
    expect(parsed.categories[3]).toMatchObject({
      name: "Quiet Corner",
      sectionId: 104,
      previewCount: 0,
      hasMore: true,
    });
    expect(parsed.categories[3]?.previewItems).toEqual([]);
  });

  it("throws a friendly error when no category blocks exist", () => {
    expect(() => parseResourceIndex("<html><body><h2>Resources</h2></body></html>")).toThrow(
      /without categories/,
    );
  });
});

describe("matchCategory", () => {
  it("matches names case-insensitively and ids exactly", () => {
    const parsed = index();
    expect(matchCategory(parsed, "riverdale")?.sectionId).toBe(101);
    expect(matchCategory(parsed, "HARBORVIEW")?.sectionId).toBe(102);
    expect(matchCategory(parsed, "103")?.name).toBe("Night Shift 2025 🌙");
    expect(matchCategory(parsed, "10")).toBeNull();
    expect(matchCategory(parsed, "no such category")).toBeNull();
    expect(matchCategory(parsed, "  ")).toBeNull();
  });
});

describe("parseResourceCategory", () => {
  it("reads the breadcrumb name and heading groups with descriptions", () => {
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
  });

  it("skips malformed rows without failing the page", () => {
    const detail = parseResourceCategory(fixture("faq-section.html"), 101);
    expect(detail.groups[0]?.items.map((item) => item.title)).toEqual(["Arriving early"]);
  });

  it("throws a friendly error when breadcrumbs are missing", () => {
    expect(() => parseResourceCategory("<html><body>redesigned</body></html>", 101)).toThrow(
      /without breadcrumbs/,
    );
  });
});

describe("parseArticle", () => {
  it("parses title, keywords, description, and nested-div body", () => {
    const article = parseArticle(fixture("article.html"), "riverdale-check-in");
    expect(article.slug).toBe("riverdale-check-in");
    expect(article.title).toBe("Checking In for Your Shift");
    expect(article.description).toBe("Badge in at the front desk before your first call.");
    expect(article.keywords).toEqual(["check-in", "urgent"]);
    expect(article.body).toBe(
      [
        "Riverdale Call Protocols",
        "Greeting/Opening: Our clients expect a pleasant “hello” & a smooth start.",
        "When the call connects, state your name & interpreter ID clearly.",
        "## During the Call",
        "Interpret in the first person, always.",
        "Nested two levels deep: confirm understanding before proceeding.",
        "- Badge visible at all times",
        "- Headset tested",
        "Read the timesheet guide and the section page. Read the timesheet guide again. Skip this.",
        "Final reminder: the last nested block holds the closing phrase.",
      ].join("\n\n"),
    );
  });

  it("absolute-ises body links, dedupes, and drops non-HTTP targets", () => {
    const article = parseArticle(fixture("article.html"), "riverdale-check-in");
    expect(article.links).toEqual([
      { text: "the timesheet guide", url: "https://globohq.com/slug/riverdale-timesheet" },
      { text: "the section page", url: "https://globohq.com/faq_sections/101" },
    ]);
  });

  it("yields empty media when the body has no video", () => {
    const article = parseArticle(
      `<div class="ibox-title"><h2>T</h2></div>` +
        `<div class="col-sm-12 m-t-md"><p>D.</p></div>` +
        `<div class="col-sm-12"><div class="hr-line-dashed"></div><div><p>Words.</p></div></div>`,
      "t",
    );
    expect(article.media).toEqual([]);
    expect(article.body).toBe("Words.");
  });

  it("returns empty body with media and no warning for video-only articles", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const article = parseArticle(fixture("article-bare.html"), "the-greeting");
      expect(article.title).toBe("The Greeting");
      expect(article.description).toBe("A short greeting video.");
      expect(article.keywords).toEqual([]);
      expect(article.body).toBe("");
      expect(article.links).toEqual([]);
      expect(article.media).toHaveLength(1);
      expect(article.media[0]?.url).toMatch(
        /^https:\/\/globo-active-storage-files\.s3\.amazonaws\.com\//,
      );
      expect(article.media[0]?.url).not.toContain("&amp;");
      expect(article.media[0]).toMatchObject({
        kind: "video",
        note: expect.stringMatching(/4 hours/),
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("isValidSlug", () => {
  it("accepts lowercase slugs and rejects traversal and junk", () => {
    expect(isValidSlug("riverdale-check-in")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("../x")).toBe(false);
    expect(isValidSlug("/etc")).toBe(false);
    expect(isValidSlug("Check-In")).toBe(false);
    expect(isValidSlug("a%2fb")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("x".repeat(101))).toBe(false);
    expect(isValidSlug("x".repeat(100))).toBe(true);
  });
});

describe("resource fetching and caching", () => {
  function stubAuth(pages: Map<string, string>): { auth: PortalAuth; requested: string[] } {
    const http = new HttpClient(PORTAL_BASE);
    const requested: string[] = [];
    http.get = async (path: string): Promise<FetchResult> => {
      requested.push(path);
      const body = pages.get(path);
      if (body === undefined) throw new Error(`unexpected portal GET to ${path}`);
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        text: body,
        url: `${PORTAL_BASE}${path}`,
      };
    };
    const auth = new PortalAuth(
      {
        email: "a@b.c",
        password: undefined,
        sessionCookie: "cookie",
        baseUrl: PORTAL_BASE,
        timezone: undefined,
      },
      http,
    );
    return { auth, requested };
  }

  it("fetches index, category, and article each once, then serves from cache", async () => {
    const { auth, requested } = stubAuth(
      new Map([
        ["/faq_sections", fixture("faq-sections.html")],
        ["/faq_sections/101", fixture("faq-section.html")],
        ["/slug/riverdale-check-in", fixture("article.html")],
      ]),
    );
    const cache = new TtlCache();
    await fetchResourceIndex(auth, cache);
    await fetchResourceIndex(auth, cache);
    await fetchResourceCategory(auth, cache, 101);
    await fetchResourceCategory(auth, cache, 101);
    await fetchArticle(auth, cache, "riverdale-check-in");
    await fetchArticle(auth, cache, "riverdale-check-in");
    expect(requested).toEqual(["/faq_sections", "/faq_sections/101", "/slug/riverdale-check-in"]);
  });

  it("validates the slug before any request", async () => {
    const { auth, requested } = stubAuth(new Map());
    await expect(fetchArticle(auth, new TtlCache(), "../x")).rejects.toThrow(
      /Invalid article slug/,
    );
    expect(requested).toEqual([]);
  });

  it("reports a non-200 category with a friendly error", async () => {
    const http = new HttpClient(PORTAL_BASE);
    http.get = async (): Promise<FetchResult> => ({
      status: 500,
      headers: new Headers(),
      text: "",
      url: `${PORTAL_BASE}/faq_sections/101`,
    });
    const auth = new PortalAuth(
      {
        email: "a@b.c",
        password: undefined,
        sessionCookie: "cookie",
        baseUrl: PORTAL_BASE,
        timezone: undefined,
      },
      http,
    );
    await expect(fetchResourceCategory(auth, new TtlCache(), 101)).rejects.toThrow(
      /Could not load the resource category \(HTTP 500\)/,
    );
  });
});

describe("MCP resource payloads", () => {
  function stubAuth(pages: Map<string, string>): { auth: PortalAuth; requested: string[] } {
    const http = new HttpClient(PORTAL_BASE);
    const requested: string[] = [];
    http.get = async (path: string): Promise<FetchResult> => {
      requested.push(path);
      const body = pages.get(path);
      if (body === undefined) throw new Error(`unexpected portal GET to ${path}`);
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        text: body,
        url: `${PORTAL_BASE}${path}`,
      };
    };
    const auth = new PortalAuth(
      {
        email: "a@b.c",
        password: undefined,
        sessionCookie: "cookie",
        baseUrl: PORTAL_BASE,
        timezone: undefined,
      },
      http,
    );
    return { auth, requested };
  }

  it("reads the index, one article, and the profile as JSON", async () => {
    const { auth } = stubAuth(
      new Map([
        ["/faq_sections", fixture("faq-sections.html")],
        ["/slug/riverdale-check-in", fixture("article.html")],
        ["/users/edit", fixture("profile.html")],
      ]),
    );
    const cache = new TtlCache();
    const indexPayload = JSON.parse(await readResourcesPayload(auth, cache)) as {
      total: number;
    };
    expect(indexPayload.total).toBe(4);
    const articlePayload = JSON.parse(
      await readResourcePayload(auth, cache, "riverdale-check-in"),
    ) as {
      title: string;
    };
    expect(articlePayload.title).toBe("Checking In for Your Shift");
    const profilePayload = JSON.parse(await readProfilePayload(auth)) as { name: string };
    expect(profilePayload.name).toBe("Test User");
  });

  it("lists preview slugs without extra requests, bounded", async () => {
    const { auth, requested } = stubAuth(
      new Map([["/faq_sections", fixture("faq-sections.html")]]),
    );
    const cache = new TtlCache();
    const first = await listResourcePreviews(auth, cache);
    expect(first).toHaveLength(6);
    expect(first[0]).toEqual({
      uri: "globo://resource/riverdale-check-in",
      name: "Checking in for your shift",
    });
    expect(await listResourcePreviews(auth, cache)).toEqual(first);
    expect(requested).toEqual(["/faq_sections"]);
  });

  it("caps the preview list at MAX_RESOURCE_LIST", async () => {
    const blocks = Array.from(
      { length: MAX_RESOURCE_LIST + 5 },
      (_, n) =>
        `<div class="col-sm-6 m-t-sm m-b-sm"><h2>Category ${n}</h2>` +
        `<ul class="faq-list"><li><a href="/slug/item-${n}">Item ${n}</a></li></ul>` +
        `<a class="btn" href="/faq_sections/${1000 + n}">More</a></div>`,
    ).join("");
    const { auth } = stubAuth(new Map([["/faq_sections", `<div>${blocks}</div>`]]));
    const listed = await listResourcePreviews(auth, new TtlCache());
    expect(listed).toHaveLength(MAX_RESOURCE_LIST);
  });
});
