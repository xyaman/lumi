// EPUB stylesheets need three transforms before they apply inside the reader's shadow root:
//   1. @import is recursively inlined (no network fetches inside shadow).
//   2. `html` / `body` selectors are rewritten to `.lumi-content` since the shadow root has no
//      <html>/<body> for author rules to target.
//   3. `url(...)` references are mapped to blob URLs for in-archive assets.

import { dirname, type Epub, resolveHref } from "@lostcoords/lumi-epub";

/** Load a stylesheet by absolute href, recursively inlining `@import` and rewriting URLs. */
export async function loadEpubCss(
  absHref: string,
  epub: Epub,
  visited: Set<string>,
  blobUrlSink: string[],
): Promise<string> {
  const res = epub.resources.get(absHref);
  if (!res) return "";
  visited.add(absHref);
  const bytes = await res.load();
  const text = new TextDecoder("utf-8").decode(bytes);
  return processCssText(text, dirname(absHref), epub, visited, blobUrlSink);
}

/** Apply all three transforms in one pass. */
export async function processCssText(
  text: string,
  baseDir: string,
  epub: Epub,
  visited: Set<string>,
  blobUrlSink: string[],
): Promise<string> {
  const inlined = await inlineImports(text, baseDir, epub, visited, blobUrlSink);
  const rewritten = rewriteSelectors(inlined);
  const clamped = clampVerticalMarginPercents(rewritten);
  return rewriteUrls(clamped, baseDir, epub, blobUrlSink);
}

// % vertical margins resolve against the container's WIDTH; clamp them against --lumi-v-margin-cap (page height) so a wide reflow column doesn't turn title-page `margin-top: 40%` into a near-blank page.
const MARGIN_PCT_RE = /(?<![-\w])(margin-(?:top|bottom))(\s*:\s*)(\d+(?:\.\d+)?|\.\d+)%/gi;

function clampVerticalMarginPercents(css: string): string {
  return css.replace(MARGIN_PCT_RE, (_, prop, sep, n) => `${prop}${sep}min(var(--lumi-v-margin-cap, 18svh), ${n}%)`);
}

/** `@import url(foo) | "foo"` with an optional media query. Path is in group 1 or 2. */
const IMPORT_RE = /@import\s+(?:url\(\s*['"]?([^'")\s]+)['"]?\s*\)|['"]([^'"]+)['"])(?:\s+[^;]*)?;/g;

async function inlineImports(
  text: string,
  baseDir: string,
  epub: Epub,
  visited: Set<string>,
  blobUrlSink: string[],
): Promise<string> {
  const matches: { index: number; length: number; href: string }[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    if (m.index === undefined) continue;
    matches.push({ index: m.index, length: m[0].length, href: m[1] ?? m[2] });
  }
  if (matches.length === 0) return text;

  // Sequential: the `visited` mutation orders to break cycles AND dedupe siblings. `null` = keep the @import (path didn't resolve); `""` = drop (already inlined upstream).
  const resolved: (string | null)[] = [];
  for (const { href } of matches) {
    const abs = resolveHref(baseDir, href);
    if (!abs || !epub.resources.has(abs)) {
      resolved.push(null);
      continue;
    }
    if (visited.has(abs)) {
      resolved.push("");
      continue;
    }
    resolved.push(await loadEpubCss(abs, epub, visited, blobUrlSink));
  }

  let out = "";
  let last = 0;
  for (let i = 0; i < matches.length; i++) {
    const { index, length } = matches[i];
    out += text.slice(last, index);
    const r = resolved[i];
    out += r === null ? text.slice(index, index + length) : `\n/* @import */\n${r}\n`;
    last = index + length;
  }
  return out + text.slice(last);
}

const URL_RE = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
const ABSOLUTE_URL_RE = /^(?:data|https?|blob):/i;

async function rewriteUrls(text: string, baseDir: string, epub: Epub, blobUrlSink: string[]): Promise<string> {
  type Hit = { index: number; length: number; quote: string; url: string };
  const hits: Hit[] = [];
  for (const m of text.matchAll(URL_RE)) {
    if (m.index === undefined) continue;
    hits.push({ index: m.index, length: m[0].length, quote: m[1], url: m[2] });
  }
  if (hits.length === 0) return text;

  const replacements = await Promise.all(
    hits.map(async ({ url }) => {
      if (ABSOLUTE_URL_RE.test(url)) return null;
      const abs = resolveHref(baseDir, url);
      if (!abs) return null;
      const r = epub.resources.get(abs);
      if (!r) return null;
      const data = await r.load();
      const blobUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: r.mediaType }));
      blobUrlSink.push(blobUrl);
      return blobUrl;
    }),
  );

  // Walk in reverse so earlier indices stay valid.
  let out = text;
  for (let i = hits.length - 1; i >= 0; i--) {
    const r = replacements[i];
    if (r === null) continue;
    const { index, length, quote } = hits[i];
    out = `${out.slice(0, index)}url(${quote}${r}${quote})${out.slice(index + length)}`;
  }
  return out;
}

// Lookbehind/ahead keeps identifiers like `.html-text` / `.body_inner` safe, and excludes `.` / `#` so bare class/id selectors (`.body`, `#html`) aren't mangled.
const HTML_BODY_RE = /(?<![\w.#-])(html|body)(?![\w-])/g;

/** At-rules whose body is a rule-list (selectors), not a declaration block. */
const RULE_LIST_AT_RULES = /^@(media|supports|-moz-document|document|container|layer)\b/;

function rewriteSelectors(css: string): string {
  // Each chunk is either rewritable (bare selector text) or opaque (inside a string or comment) so the html/body rewrite only touches the former.
  let chunks: { rewritable: boolean; text: string }[] = [];
  const stack: ("rule-list" | "declarations")[] = [];
  const inSelectorCtx = (): boolean => stack.length === 0 || stack[stack.length - 1] === "rule-list";

  const append = (text: string, rewritable: boolean): void => {
    const last = chunks[chunks.length - 1];
    if (last && last.rewritable === rewritable) last.text += text;
    else chunks.push({ rewritable, text });
  };

  const trimmedHead = (): string => chunks.map((c) => c.text).join("").trim();

  const flush = (rewriteSelectors: boolean): string => {
    let result = "";
    for (const ch of chunks) {
      result += ch.rewritable && rewriteSelectors ? ch.text.replace(HTML_BODY_RE, ".lumi-content") : ch.text;
    }
    chunks = [];
    return result;
  };

  let out = "";
  let i = 0;
  let inComment = false;
  let inString: '"' | "'" | null = null;

  while (i < css.length) {
    const c = css[i];

    if (inComment) {
      append(c, false);
      if (c === "*" && css[i + 1] === "/") {
        append("/", false);
        i += 2;
        inComment = false;
        continue;
      }
      i++;
      continue;
    }

    if (inString) {
      append(c, false);
      if (c === "\\" && i + 1 < css.length) {
        append(css[i + 1], false);
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }

    if (c === "/" && css[i + 1] === "*") {
      append("/*", false);
      i += 2;
      inComment = true;
      continue;
    }

    if (c === '"' || c === "'") {
      append(c, false);
      inString = c;
      i++;
      continue;
    }

    if (c === "{") {
      const trimmed = trimmedHead();
      const isAtRule = trimmed.startsWith("@");
      out += `${flush(!isAtRule && inSelectorCtx())}{`;
      stack.push(RULE_LIST_AT_RULES.test(trimmed) ? "rule-list" : "declarations");
      i++;
      continue;
    }

    if (c === "}") {
      out += `${flush(false)}}`;
      stack.pop();
      i++;
      continue;
    }

    if (c === ";" && inSelectorCtx() && trimmedHead().startsWith("@")) {
      // @charset / @namespace / leftover @import — pass through.
      out += `${flush(false)};`;
      i++;
      continue;
    }

    append(c, true);
    i++;
  }
  return out + flush(false);
}
