/**
 * GLOBO knowledge base (Resources): HTML-scraped help articles. Three pages,
 * no JSON twin — scraping is the only path, as with `/scheduled_calls`:
 *
 * - `GET /faq_sections` → the index: category blocks with a ≤5-item preview
 *   plus a More link each. Outer `h2` headings reading "Resources" are page
 *   titles, never categories — only the category blocks are read.
 * - `GET /faq_sections/<id>` → one category: breadcrumb name plus grouped
 *   item rows (title, slug, one-line description).
 * - `GET /slug/<slug>` → one article: title, keyword spans, description,
 *   structured body text, outbound links, and media.
 *
 * Slugs are lowercase letters, numbers, and dashes; anything else is
 * rejected before any URL is built. Media URLs are pre-signed S3 links that
 * expire in about 4 hours — passed through with that note, never presented
 * as stable. Outbound links come from the article body only (navigation
 * links live outside the content blocks).
 *
 * Parsing is defensive: a malformed block or row is skipped with a stderr
 * warning and never fails the whole page; bad scalar fields become `null`.
 */

import type { PortalAuth } from "../auth.js";
import type { TtlCache } from "./cache.js";
import { getProfile } from "./profile.js";

const INDEX_PATH = "/faq_sections";

/** One preview item on the index (the index shows at most 5 per category). */
export interface PreviewItem {
  title: string;
  slug: string;
}

/** One category block on the index. */
export interface ResourceCategory {
  name: string;
  /** Section id from the More link; null when the block has none. */
  sectionId: number | null;
  previewItems: PreviewItem[];
  /** Items shown in the preview. */
  previewCount: number;
  /** True when the block carries a More link (i.e. more than the preview). */
  hasMore: boolean;
  /** Absolute path of the section page, or null without a More link. */
  sectionUrl: string | null;
}

/** The resources index. */
export interface ResourceIndex {
  total: number;
  categories: ResourceCategory[];
}

/** One item row on a category page. */
export interface CategoryItem {
  title: string;
  slug: string;
  description: string | null;
}

/** One heading group on a category page (name null when the block has no `h4`). */
export interface CategoryGroup {
  name: string | null;
  items: CategoryItem[];
}

/** One category page. */
export interface ResourceCategoryDetail {
  category: { name: string | null; sectionId: number };
  total: number;
  groups: CategoryGroup[];
}

/** One outbound link from an article body. */
export interface ArticleLink {
  text: string;
  url: string;
}

/** One media embed from an article body. */
export interface ArticleMedia {
  url: string;
  kind: "video";
  note: string;
}

/** One knowledge-base article. */
export interface KnowledgeArticle {
  slug: string;
  title: string | null;
  description: string | null;
  keywords: string[];
  body: string;
  links: ArticleLink[];
  media: ArticleMedia[];
}

function warn(message: string): void {
  console.error(`[globo-mcp] warning: ${message}`);
}

/** Decode the entities the portal emits (`&nbsp;`, quotes, dashes, basics). */
function decodeEntities(raw: string): string {
  return raw
    .replace(/&nbsp;|&#160;/g, "\u00A0")
    .replace(/&ldquo;|&#8220;/g, "“")
    .replace(/&rdquo;|&#8221;/g, "”")
    .replace(/&lsquo;|&#8216;/g, "‘")
    .replace(/&rsquo;|&#8217;/g, "’")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&hellip;|&#8230;/g, "…")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&ndash;|&#8211;/g, "–")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/** Collapse whitespace, decode entities, and trim. */
function clean(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

/** Strip any nested tags, then clean. */
function textOf(rawHtml: string): string {
  return clean(rawHtml.replace(/<[^>]*>/g, " "));
}

/** Text cell: cleaned text, or null when empty. */
function textCell(html: string | undefined): string | null {
  if (html === undefined) return null;
  const text = textOf(html);
  return text === "" ? null : text;
}

/**
 * True for safe article slugs: lowercase letters, numbers, and dashes,
 * 1–100 chars. Anything else (traversal, slashes, escapes, uppercase) is
 * rejected before any URL is built.
 */
export function isValidSlug(slug: string): boolean {
  return slug.length >= 1 && slug.length <= 100 && /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

/**
 * Render article body HTML as readable text: headings as `## `/`### `,
 * list items as `- `, `<br>`, `</div>`, `</p>`, and `</li>` as line breaks
 * (consecutive breaks collapse to at most one blank line), entities
 * unescaped. The portal lays prose out as `<br>`-separated div sequences,
 * so closing divs are paragraph breaks. `<script>`, `<style>`, and comments
 * are dropped entirely — player bootstrap code and nonces must never leak
 * into the text. Tables and other blocks degrade to spaced text.
 */
function bodyToText(html: string): string {
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<(h[1-3])[^>]*>/gi, "\n## ")
      .replace(/<(h[4-6])[^>]*>/gi, "\n### ")
      .replace(/<\/(h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/(li|ul|ol)>/gi, "\n")
      .replace(/<\/(p|div|tr|table)>/gi, "\n\n")
      .replace(/<(tr)[^>]*>/gi, "\n")
      .replace(/<(td|th)[^>]*>/gi, " ")
      // Inline tags strip to nothing (faithful to rendering: `foo<a>x</a>bar`
      // reads "fooxbar"); block separation comes from the rules above, and
      // table cells keep an explicit space.
      .replace(/<[^>]+>/g, ""),
  );
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00A0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Absolute-ise an article-body href against the article URL (http/https only). */
function absoluteLink(href: string, base: string): string | null {
  const cleaned = href.trim();
  if (cleaned === "") return null;
  try {
    const target = new URL(cleaned, base);
    if (target.protocol !== "https:" && target.protocol !== "http:") return null;
    return target.toString();
  } catch {
    return null;
  }
}

/**
 * Parse the resources index. Category blocks are matched by their distinctive
 * `col-sm-6` wrapper — the outer "Resources" `h2` titles never match, so
 * they cannot leak in as categories. Throws a friendly error when no blocks
 * are found at all (the page changed); blocks without a heading are skipped.
 */
export function parseResourceIndex(html: string): ResourceIndex {
  const categories: ResourceCategory[] = [];
  const close = divCloseIndex(html);
  const blockOpenRe = /<div[^>]*class="[^"]*\bcol-sm-6\b[^"]*"[^>]*>/gi;
  let open: RegExpExecArray | null;
  while ((open = blockOpenRe.exec(html)) !== null) {
    // Depth-scanned: a `<div>` nested inside the block no longer truncates
    // the capture (and with it the previews, id, and More link).
    const inner = captureDivAt(html, open.index, close);
    if (inner === null) {
      warn("skipping resource block with unbalanced markup");
      continue;
    }
    const name = textCell(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(inner)?.[1]);
    if (name === null) {
      warn("skipping resource block without a heading");
      continue;
    }
    const previewItems: PreviewItem[] = [];
    const list = /<ul[^>]*class="[^"]*\bfaq-list\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i.exec(inner);
    if (list?.[1]) {
      const linkRe = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      let link: RegExpExecArray | null;
      while ((link = linkRe.exec(list[1])) !== null) {
        const slug = /^\/slug\/([A-Za-z0-9-]+)$/.exec((link[1] ?? "").trim())?.[1];
        const title = textCell(link[2]);
        if (slug === undefined || title === null) continue;
        previewItems.push({ title, slug });
      }
    }
    const sectionId = /<a[^>]*href="\/faq_sections\/(\d+)"[^>]*>/i.exec(inner)?.[1];
    categories.push({
      name,
      sectionId: sectionId === undefined ? null : Number(sectionId),
      previewItems,
      previewCount: previewItems.length,
      hasMore: sectionId !== undefined,
      sectionUrl: sectionId === undefined ? null : `/faq_sections/${sectionId}`,
    });
  }
  if (categories.length === 0) {
    throw new Error(
      "The resources index came back without categories. The portal may have changed.",
    );
  }
  return { total: categories.length, categories };
}

/** Fetch (and cache) the resources index. */
export async function fetchResourceIndex(
  auth: PortalAuth,
  cache: TtlCache,
): Promise<ResourceIndex> {
  const key = new URL(INDEX_PATH, auth.client.baseUrl).href;
  const cached = cache.get<ResourceIndex>(key);
  if (cached) return cached;
  const result = await auth.fetchWithAuth(INDEX_PATH);
  if (result.status !== 200) {
    throw new Error(
      `Could not load the resources index (HTTP ${result.status}). The portal may be down.`,
    );
  }
  const index = parseResourceIndex(result.text);
  cache.set(key, index);
  return index;
}

/**
 * Match user input against a category name (case-insensitive substring) or
 * an exact numeric section id string. First match in index order wins.
 */
export function matchCategory(index: ResourceIndex, input: string): ResourceCategory | null {
  const query = input.trim().toLowerCase();
  if (query === "") return null;
  if (/^\d+$/.test(query)) {
    return (
      index.categories.find((c) => c.sectionId !== null && String(c.sectionId) === query) ?? null
    );
  }
  return index.categories.find((c) => c.name.toLowerCase().includes(query)) ?? null;
}

/**
 * Parse one category page. Rows attach to the most recent preceding
 * `ibox-title` block (name null when it carries no `h4`); rows before any
 * title form a leading null group. Empty groups are dropped — a heading with
 * no rows navigates nowhere. Throws a friendly error when the breadcrumb
 * trail is missing (the page changed).
 */
export function parseResourceCategory(html: string, sectionId: number): ResourceCategoryDetail {
  const crumbs = /<ol[^>]*\bid\s*=\s*["']?breadcrumbs_target["']?[^>]*>([\s\S]*?)<\/ol>/i.exec(
    html,
  );
  if (!crumbs?.[1]) {
    throw new Error(
      "The resource category came back without breadcrumbs. The portal may have changed.",
    );
  }
  const crumbNames: string[] = [];
  const crumbRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let crumb: RegExpExecArray | null;
  while ((crumb = crumbRe.exec(crumbs[1])) !== null) {
    const text = textOf(crumb[1] ?? "");
    if (text !== "") crumbNames.push(text);
  }
  const name = crumbNames.length === 0 ? null : (crumbNames[crumbNames.length - 1] ?? null);

  const groups: CategoryGroup[] = [];
  const close = divCloseIndex(html);
  const boundaryOpenRe = /<div[^>]*class="[^"]*\bibox-title\b[^"]*"[^>]*>/gi;
  const boundaries: { index: number; name: string | null }[] = [];
  let boundaryOpen: RegExpExecArray | null;
  while ((boundaryOpen = boundaryOpenRe.exec(html)) !== null) {
    // Depth-scanned like everything else: nested markup inside the title
    // cannot cut the `h4` lookup short.
    const inner = captureDivAt(html, boundaryOpen.index, close);
    boundaries.push({
      index: boundaryOpen.index,
      name: inner === null ? null : textCell(/<h4[^>]*>([\s\S]*?)<\/h4>/i.exec(inner)?.[1]),
    });
  }
  const rowOpenRe = /<div[^>]*class="[^"]*\binline\b[^"]*"[^>]*>/gi;
  let rowOpen: RegExpExecArray | null;
  // Walk rows in page order; each `ibox-title` boundary opens a new group
  // (null-named when it carries no `h4`), rows before any title form a
  // leading null group, and empty groups are dropped at the end.
  let current: { name: string | null; items: CategoryItem[] } | null = null;
  let boundaryAt = 0;
  const flush = (): void => {
    if (current && current.items.length > 0) {
      groups.push({ name: current.name, items: current.items });
    }
    current = null;
  };
  while ((rowOpen = rowOpenRe.exec(html)) !== null) {
    while (boundaryAt < boundaries.length && (boundaries[boundaryAt]?.index ?? 0) < rowOpen.index) {
      flush();
      current = { name: boundaries[boundaryAt]?.name ?? null, items: [] };
      boundaryAt += 1;
    }
    if (!current) current = { name: null, items: [] };
    // Depth-scanned: a `<div>` nested inside the row no longer truncates the
    // capture (and with it the `<small>` description).
    const inner = captureDivAt(html, rowOpen.index, close);
    if (inner === null) {
      warn("skipping resource row with unbalanced markup");
      continue;
    }
    const href = /<a[^>]*href="([^"]*)"[^>]*>/i.exec(inner)?.[1]?.trim() ?? "";
    const slug = /^\/slug\/([A-Za-z0-9-]+)$/.exec(href)?.[1];
    const title = textCell(/<strong[^>]*>([\s\S]*?)<\/strong>/i.exec(inner)?.[1]);
    if (slug === undefined || title === null) {
      warn("skipping resource row without a slug link or title");
      continue;
    }
    current.items.push({
      title,
      slug,
      description: textCell(/<small[^>]*>([\s\S]*?)<\/small>/i.exec(inner)?.[1]),
    });
  }
  flush();
  return {
    category: { name, sectionId },
    total: groups.reduce((sum, group) => sum + group.items.length, 0),
    groups,
  };
}

/** Fetch (and cache) one category page. */
export async function fetchResourceCategory(
  auth: PortalAuth,
  cache: TtlCache,
  sectionId: number,
): Promise<ResourceCategoryDetail> {
  const path = `/faq_sections/${sectionId}`;
  const key = new URL(path, auth.client.baseUrl).href;
  const cached = cache.get<ResourceCategoryDetail>(key);
  if (cached) return cached;
  const result = await auth.fetchWithAuth(path);
  if (result.status !== 200) {
    throw new Error(
      `Could not load the resource category (HTTP ${result.status}). The portal may be down.`,
    );
  }
  const detail = parseResourceCategory(result.text, sectionId);
  cache.set(key, detail);
  return detail;
}

/**
 * Extract the article body container: the first opening `<div` after the
 * `hr-line-dashed` marker, scanned forward with depth counting to its
 * matching close. When no content div follows the marker (video-only
 * articles), the marker's own parent is the container instead — scanned to
 * its enclosing close. `<script>`/`<style>` blocks and comments are skipped
 * as units, so embedded player code can never unbalance the scan (or leak
 * into the text). Returns the inner HTML, or null only when no container
 * exists. The scan always terminates: every alternative consumes input, and
 * an unbalanced remainder simply yields null (fail closed, never hang).
 */
/**
 * Capture the inner HTML of the `<div` opening at `index`, depth-scanned to
 * its matching close (script/style blocks and comments skipped as units).
 * Returns null when unbalanced or when nothing opens at `index` — fail
 * closed, never hang. A `<div>` nested inside the capture no longer
 * truncates it, unlike a lazy `([\s\S]*?)<\/div>` match.
 *
 * When `close` (from {@link divCloseIndex}) is provided, the matching close
 * is looked up in O(1) instead of rescanning the document — the three
 * per-match loops pass the index while `extractBodyContainer` (one call per
 * article) keeps the direct scan.
 */
function captureDivAt(html: string, index: number, close?: Map<number, number>): string | null {
  const open = /^<div\b[^>]*>/i.exec(html.slice(index));
  if (!open) return null;
  if (close !== undefined) {
    const end = close.get(index);
    return end === undefined ? null : html.slice(index + open[0].length, end);
  }
  const end = scanToClose(html, index + open[0].length, 1);
  return end === null ? null : html.slice(index + open[0].length, end);
}

/**
 * One-pass index of matching div closes: `close.get(openOffset)` is the
 * offset of the `</div>` that closes the `<div` opening at `openOffset`.
 * Same token walk as {@link scanToClose} (comments and script/style blocks
 * skipped as units) so lookups agree byte-for-byte with the direct scan;
 * unbalanced openers simply have no entry.
 */
function divCloseIndex(html: string): Map<number, number> {
  const close = new Map<number, number>();
  const tokenRe = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?div\b[^>]*>/gi;
  const stack: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html)) !== null) {
    const token = match[0];
    if (/^<!--|^<(script|style)\b/i.test(token)) continue;
    if (token[1] === "/") {
      const openOffset = stack.pop();
      if (openOffset !== undefined) close.set(openOffset, match.index);
    } else {
      stack.push(match.index);
    }
  }
  return close;
}

function extractBodyContainer(html: string): string | null {
  const marker = /<div[^>]*class="[^"]*\bhr-line-dashed\b[^"]*"[^>]*>\s*<\/div>/i.exec(html);
  if (!marker) return null;
  const rest = html.slice(marker.index + marker[0].length);
  // Text layout: a content div opens right after the marker (modulo
  // whitespace/comments) — capture it. Unbalanced markup falls through to
  // the parent span below instead of failing.
  const skipped = /^(?:\s|<!--[\s\S]*?-->)*/.exec(rest)?.[0].length ?? 0;
  const contentAt = marker.index + marker[0].length + skipped;
  if (/^<div\b/i.test(html.slice(contentAt))) {
    const captured = captureDivAt(html, contentAt);
    if (captured !== null) return captured;
  }
  // Video layout: no content div — the marker's own parent holds the
  // video/script, so scan to the enclosing close instead.
  const end = scanToClose(rest, 0, 0);
  return end === null ? null : rest.slice(0, end);
}

/**
 * Scan div open/close tags from `from`, starting at `depth`; returns the
 * index of the close that brings depth to zero, or null when unbalanced.
 * Script/style blocks and comments are skipped as units. Always terminates
 * (every alternative consumes input); unbalanced input yields null instead
 * of hanging. Depth never goes negative: a close met at zero is the
 * enclosing close (parent mode); otherwise closes count down to it.
 */
function scanToClose(text: string, from: number, depth: number): number | null {
  const tokenRe = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?div\b[^>]*>/gi;
  tokenRe.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    const token = match[0];
    if (/^<!--|^<(script|style)\b/i.test(token)) continue;
    if (token[1] === "/") {
      if (depth === 0) return match.index;
      depth -= 1;
      if (depth === 0) return match.index;
    } else {
      depth += 1;
    }
  }
  return null;
}

/**
 * Parse one article page. A missing title, description, or body container
 * each warn (the page changed); a present-but-empty body (e.g. a video-only
 * article) is legitimate and silent. Keywords, links, and media default to
 * empty — articles may legitimately have none.
 */
export function parseArticle(html: string, slug: string): KnowledgeArticle {
  const title = textCell(
    /<div[^>]*class="[^"]*\bibox-title\b[^"]*"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(html)?.[1],
  );
  if (title === null) {
    warn("article page has no title; the portal may have changed");
  }
  const keywords: string[] = [];
  const keywordRe =
    /<span[^>]*class="[^"]*\blabel-(?:inverse|important|warning)\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  let keyword: RegExpExecArray | null;
  while ((keyword = keywordRe.exec(html)) !== null) {
    const text = textOf(keyword[1] ?? "");
    if (text !== "") keywords.push(text);
  }
  const description = textCell(
    /<div[^>]*class="[^"]*\bcol-sm-12 m-t-md\b[^"]*"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i.exec(
      html,
    )?.[1],
  );
  if (description === null) {
    warn("article page has no description; the portal may have changed");
  }
  // Body blocks nest arbitrarily (div prose sequences, tables), so the
  // container is depth-scanned — never cut at the first `</div>`.
  const bodyHtml = extractBodyContainer(html);
  if (bodyHtml === null) {
    warn("article page has no body content; the portal may have changed");
  }
  const body = bodyHtml === null ? "" : bodyToText(bodyHtml);
  const articleUrl = `https://globohq.com/slug/${slug}`;
  const links: ArticleLink[] = [];
  const seenUrls = new Set<string>();
  if (bodyHtml !== null) {
    // Outbound links come from the body only: navigation links live outside
    // the content blocks and must never leak in here.
    const linkRe = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let link: RegExpExecArray | null;
    while ((link = linkRe.exec(bodyHtml)) !== null) {
      const url = absoluteLink(link[1] ?? "", articleUrl);
      if (url === null || seenUrls.has(url)) continue;
      seenUrls.add(url);
      links.push({ text: textOf(link[2] ?? ""), url });
    }
  }
  const media: ArticleMedia[] = [];
  if (bodyHtml !== null) {
    const mediaRe = /<video[^>]*\bsrc="([^"]*)"[^>]*>/gi;
    let tag: RegExpExecArray | null;
    while ((tag = mediaRe.exec(bodyHtml)) !== null) {
      const url = (tag[1] ?? "").replace(/&amp;/g, "&").trim();
      if (url === "") continue;
      media.push({
        url,
        kind: "video",
        note: "Pre-signed URL: expires in about 4 hours — do not treat as a stable link.",
      });
    }
  }
  return { slug, title, description, keywords, body, links, media };
}

/** Fetch (and cache) one article. The slug is validated before any URL is built. */
export async function fetchArticle(
  auth: PortalAuth,
  cache: TtlCache,
  slug: string,
): Promise<KnowledgeArticle> {
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid article slug ${JSON.stringify(slug)}. Use lowercase letters, numbers, and dashes only.`,
    );
  }
  const path = `/slug/${slug}`;
  const key = new URL(path, auth.client.baseUrl).href;
  const cached = cache.get<KnowledgeArticle>(key);
  if (cached) return cached;
  const result = await auth.fetchWithAuth(path);
  if (result.status !== 200) {
    throw new Error(`Could not load the article (HTTP ${result.status}). The portal may be down.`);
  }
  const article = parseArticle(result.text, slug);
  cache.set(key, article);
  return article;
}

/** JSON text for `globo://resources`. */
export async function readResourcesPayload(auth: PortalAuth, cache: TtlCache): Promise<string> {
  return JSON.stringify(await fetchResourceIndex(auth, cache));
}

/** JSON text for `globo://resource/<slug>` (the slug is validated, as in the tool). */
export async function readResourcePayload(
  auth: PortalAuth,
  cache: TtlCache,
  slug: string,
): Promise<string> {
  return JSON.stringify(await fetchArticle(auth, cache, slug));
}

/** JSON text for `globo://profile`. */
export async function readProfilePayload(auth: PortalAuth): Promise<string> {
  return JSON.stringify(await getProfile(auth));
}

/** Upper bound on template `list` entries: previews only, bounded by design. */
export const MAX_RESOURCE_LIST = 100;

/**
 * Preview entries for the `globo://resource/{slug}` template `list`
 * callback. Reads the (cached) index only — never fetches articles.
 */
export async function listResourcePreviews(
  auth: PortalAuth,
  cache: TtlCache,
): Promise<{ uri: string; name: string }[]> {
  const index = await fetchResourceIndex(auth, cache);
  return index.categories
    .flatMap((category) => category.previewItems)
    .slice(0, MAX_RESOURCE_LIST)
    .map((item) => ({ uri: `globo://resource/${item.slug}`, name: item.title }));
}
