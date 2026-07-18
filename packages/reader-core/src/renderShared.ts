// Shared render building blocks: load a spine doc into a live DOM, rewrite in-archive
// references to blob URLs, collect publisher CSS, and provide reader-owned host/user stylesheets.

import { dirname, type Epub, resolveHref } from "@lostcoords/lumi-epub";
import { loadEpubCss, processCssText } from "./css";

/** Top padding (px) applied around the visible content. */
export const PAD_TOP = 72;
/** Bottom padding (px) applied around the visible content. */
export const PAD_BOTTOM = 48;
/** ResizeObserver debounce (window resize, orientation flip, mobile keyboard) shared by both reader views. */
export const RESIZE_DEBOUNCE_MS = 120;
/** Writing-mode class tokens appearing in publisher html/body classes. */
export const WRITING_MODE_CLASS_RE = /\b(?:hltr|vrtl|vltr)\b/g;

const textDecoder = new TextDecoder("utf-8");

// Lazy so importing this module does not require a DOM (the engine is unit-tested under Node);
// renderers call `loadSpineDocument` only in-browser.
let domParserInstance: DOMParser | null = null;
function getDomParser(): DOMParser {
  return (domParserInstance ??= new DOMParser());
}

/** A parsed spine document, ready to mount into the renderer's DOM. */
export type LoadedSpineDocument = {
  doc: Document;
  htmlEl: Element | null;
  bodyEl: HTMLBodyElement;
  baseDir: string;
  htmlClasses: string;
  bodyClasses: string;
  lang: string;
};

/** Inputs to `loadPublisherCss`. `cssHrefs` is already absolute; `htmlEl` is only consulted for inline `<head>` `<style>` blocks (the parser doesn't capture them). `isImageOnly` mirrors `Section.isImageOnly`. */
export type PublisherCssSource = {
  htmlEl: Element | null;
  baseDir: string;
  isImageOnly: boolean;
  cssHrefs: string[];
};

/** A bucket for blob URLs produced by CSS/image rewriting. Tracked so they can be revoked on destroy. */
export type BlobUrlStore = {
  urls: string[];
  byHref: Map<string, string>;
  pendingByHref: Map<string, Promise<string>>;
};

/** A sink for collected blob URLs — either a flat array (single render) or a `BlobUrlStore` (continuous). */
type BlobUrlSink = string[] | BlobUrlStore;

export function createBlobUrlStore(): BlobUrlStore {
  return { urls: [], byHref: new Map(), pendingByHref: new Map() };
}

/** Parse a spine item's bytes into a DOM, falling back to HTML mode on `<parsererror>`. */
export async function loadSpineDocument(href: string, epub: Epub): Promise<LoadedSpineDocument | null> {
  const res = epub.resources.get(href);
  if (!res) return null;

  const bytes = await res.load();
  const html = quarantineMarkup(textDecoder.decode(bytes));
  const parser = getDomParser();
  let doc = parser.parseFromString(html, "application/xhtml+xml");
  if (doc.querySelector("parsererror")) doc = parser.parseFromString(html, "text/html");
  sanitizeDocument(doc);
  normalizeCdata(doc);
  restoreNavigationHrefs(doc);

  const bodyEl = doc.body as HTMLBodyElement | null;
  if (!bodyEl) return null;

  const htmlEl = doc.documentElement;
  return {
    doc,
    htmlEl,
    bodyEl,
    baseDir: dirname(href),
    htmlClasses: htmlEl?.getAttribute("class") ?? "",
    bodyClasses: bodyEl.getAttribute("class") ?? "",
    lang: htmlEl?.getAttribute("lang") ?? htmlEl?.getAttribute("xml:lang") ?? epub.meta.language,
  };
}

/** Load and rewrite a single publisher CSS source into an array of CSS strings (one per linked stylesheet + inline `<style>` block). */
export async function loadPublisherCss(
  source: PublisherCssSource,
  epub: Epub,
  usePublisherStyles: boolean,
  blobUrls: BlobUrlSink,
): Promise<string[]> {
  return collectPublisherCss([source], epub, usePublisherStyles, blobUrls);
}

/** Concatenate publisher CSS across many sections (used by the continuous renderer). */
export async function loadCombinedPublisherCss(
  sources: PublisherCssSource[],
  epub: Epub,
  usePublisherStyles: boolean,
  blobUrls: BlobUrlSink,
): Promise<string> {
  return (await collectPublisherCss(sources, epub, usePublisherStyles, blobUrls)).join("\n");
}

/** Rewrite `<img src>` and `<image href>/<image xlink:href>` in `doc` to blob URLs for in-archive assets. */
export async function rewriteResourceUrls(
  doc: Document,
  epub: Epub,
  baseDir: string,
  urls: BlobUrlSink,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const el of doc.querySelectorAll("img, audio, video, source, track, input[src], input[data-lumi-src]")) {
    el.removeAttribute("srcset");
    el.removeAttribute("data-lumi-srcset");
    if (el.hasAttribute("src") || el.hasAttribute("data-lumi-src")) {
      tasks.push(rewriteResourceAttribute(el, "src", epub, baseDir, urls));
    }
  }
  for (const video of doc.querySelectorAll("video[poster], video[data-lumi-poster]")) {
    tasks.push(rewriteResourceAttribute(video, "poster", epub, baseDir, urls));
  }
  for (const im of doc.querySelectorAll("image, use, feImage")) {
    tasks.push(
      (async () => {
        const raw =
          im.getAttribute("href") ??
          im.getAttribute("xlink:href") ??
          im.getAttribute("data-lumi-href") ??
          im.getAttribute("data-lumi-xlink-href");
        if (!raw) return;
        im.removeAttribute("data-lumi-href");
        im.removeAttribute("data-lumi-xlink-href");
        if (raw.startsWith("#") || raw.startsWith("data:")) {
          im.setAttribute("href", raw);
          return;
        }
        const url = await resolveBlobUrl(epub, raw, baseDir, urls);
        if (!url) {
          im.removeAttribute("href");
          im.removeAttribute("xlink:href");
          return;
        }
        const hash = raw.indexOf("#");
        im.setAttribute("href", hash >= 0 ? `${url}${raw.slice(hash)}` : url);
        im.removeAttribute("xlink:href");
      })(),
    );
  }
  const cssUrlSink = Array.isArray(urls) ? urls : urls.urls;
  for (const el of doc.querySelectorAll<HTMLElement>("[style]")) {
    const inline = el.getAttribute("style");
    if (!inline || !/url\s*\(|@import/i.test(inline)) continue;
    tasks.push(
      processCssText(inline, baseDir, epub, new Set(), cssUrlSink).then((safe) => {
        if (safe) el.setAttribute("style", safe);
        else el.removeAttribute("style");
      }),
    );
  }
  for (const style of doc.querySelectorAll("body style")) {
    tasks.push(
      processCssText(style.textContent ?? "", baseDir, epub, new Set(), cssUrlSink).then((safe) => {
        style.textContent = safe;
      }),
    );
  }
  await Promise.all(tasks);
}

async function rewriteResourceAttribute(
  el: Element,
  attribute: string,
  epub: Epub,
  baseDir: string,
  urls: BlobUrlSink,
): Promise<void> {
  const quarantined = `data-lumi-${attribute}`;
  const raw = (el.getAttribute(attribute) ?? el.getAttribute(quarantined))?.trim();
  el.removeAttribute(quarantined);
  if (!raw) return;
  if (raw.startsWith("data:")) {
    el.setAttribute(attribute, raw);
    return;
  }
  const url = await resolveBlobUrl(epub, raw, baseDir, urls);
  if (url) el.setAttribute(attribute, url);
  else el.removeAttribute(attribute);
}

// DOMParser documents are normally inert, but engines are allowed to begin
// fetching some subresources while parsing. Quarantine those attributes before
// parsing; rewriteResourceUrls later restores only data: or in-archive blob URLs.
function quarantineMarkup(html: string): string {
  const withoutActiveContainers = html
    .replace(/<(script|iframe|frameset|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(?:script|iframe|frame|frameset|object|embed|base|link)\b[^>]*\/?\s*>/gi, "");
  return withoutActiveContainers
    .replace(/\s+xlink:href\s*=/gi, " data-lumi-xlink-href=")
    .replace(/\s+(srcset|src|poster|href|action|formaction|ping)\s*=/gi, (_match, name: string) => {
      return ` data-lumi-${name.toLowerCase()}=`;
    });
}

function restoreNavigationHrefs(doc: Document): void {
  for (const anchor of doc.querySelectorAll("a[data-lumi-href]")) {
    const href = anchor.getAttribute("data-lumi-href");
    anchor.removeAttribute("data-lumi-href");
    if (href !== null) anchor.setAttribute("href", href);
  }
}

async function resolveBlobUrl(epub: Epub, rawHref: string, baseDir: string, urls: BlobUrlSink): Promise<string | null> {
  const abs = resolveHref(baseDir, rawHref);
  if (!abs) return null;
  const cached = Array.isArray(urls) ? undefined : urls.byHref.get(abs);
  if (cached) return cached;
  const pending = Array.isArray(urls) ? undefined : urls.pendingByHref.get(abs);
  if (pending) return pending;
  const r = epub.resources.get(abs);
  if (!r) return null;
  const create = r.load().then((data) => URL.createObjectURL(new Blob([data as BlobPart], { type: r.mediaType })));
  if (!Array.isArray(urls)) urls.pendingByHref.set(abs, create);
  try {
    const url = await create;
    if (Array.isArray(urls)) urls.push(url);
    else {
      urls.byHref.set(abs, url);
      urls.urls.push(url);
    }
    return url;
  } finally {
    if (!Array.isArray(urls)) urls.pendingByHref.delete(abs);
  }
}

/** CDATA is legal in XHTML but disappears when nodes enter an HTML document; turn it into ordinary text first. */
function normalizeCdata(root: Node): void {
  for (let child = root.firstChild; child; ) {
    const next = child.nextSibling;
    if (child.nodeType === 4) {
      const owner = child.ownerDocument ?? (root as Document);
      child.parentNode?.replaceChild(owner.createTextNode(child.nodeValue ?? ""), child);
    }
    else normalizeCdata(child);
    child = next;
  }
}

/** Remove active/network-capable markup; EPUB content is treated as an untrusted document. */
function sanitizeDocument(doc: Document): void {
  for (const el of doc.querySelectorAll("script, iframe, frame, frameset, object, embed, base, link")) el.remove();
  for (const form of doc.querySelectorAll("form")) {
    const parent = form.parentNode;
    if (!parent) continue;
    while (form.firstChild) parent.insertBefore(form.firstChild, form);
    parent.removeChild(form);
  }
  for (const meta of doc.querySelectorAll("meta[http-equiv]")) {
    if ((meta.getAttribute("http-equiv") ?? "").toLowerCase() === "refresh") meta.remove();
  }
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) el.removeAttribute(attr.name);
    }
    el.removeAttribute("formaction");
    el.removeAttribute("ping");
  }
}

async function collectPublisherCss(
  sources: PublisherCssSource[],
  epub: Epub,
  usePublisherStyles: boolean,
  blobUrls: BlobUrlSink,
): Promise<string[]> {
  if (!usePublisherStyles) return [];

  const seenLinked = new Set<string>();
  const seenInline = new Set<string>();
  const visited = new Set<string>();
  const sink = Array.isArray(blobUrls) ? blobUrls : blobUrls.urls;
  const out: string[] = [];

  for (const { htmlEl, baseDir, isImageOnly, cssHrefs } of sources) {
    if (isImageOnly) continue;

    // Linked stylesheets from the parsed Section — already absolute and ordered.
    for (const abs of cssHrefs) {
      if (seenLinked.has(abs)) continue;
      seenLinked.add(abs);
      const css = await loadEpubCss(abs, epub, visited, sink);
      if (css) out.push(css);
    }

    // Inline <head> <style> blocks aren't captured by the parser; read them off the live document.
    for (const styleEl of htmlEl?.querySelectorAll("head style") ?? []) {
      const text = styleEl.textContent ?? "";
      const key = `${baseDir}\u0000${text}`;
      if (seenInline.has(key)) continue;
      seenInline.add(key);
      const css = await processCssText(text, baseDir, epub, visited, sink);
      if (css) out.push(css);
    }
  }

  return out;
}

/** Defaults are wrapped in `:where()` so EPUB rules win on equal specificity. Viewport-specific geometry is still provided inline by each renderer. */
export const HOST_CSS = `
:host {
  display: block;
  height: 100%;
  width: 100%;
  --reader-fg: var(--reader-ink, #2a2520);
  --reader-link: color-mix(in srgb, var(--reader-accent, #5b6cb0) 65%, transparent);
}
:where(.lumi-content) {
  font-family: 'Iowan Old Style','Charter',Georgia,'Times New Roman',serif;
  color: var(--reader-fg);
  position: relative;
  box-sizing: border-box;
  margin: 0;
  width: 100%;
}
:where(.lumi-content) p { margin-block: 0 1em; }
:where(.lumi-content) h1, :where(.lumi-content) h2, :where(.lumi-content) h3, :where(.lumi-content) h4 {
  font-weight: 600; line-height: 1.25; margin-block: 1.5em 0.5em;
}
:where(.lumi-content) h1 { font-size: 1.75rem; }
:where(.lumi-content) h2 { font-size: 1.5rem; }
:where(.lumi-content) h3 { font-size: 1.25rem; }

/* Layout guard: publisher .fit rules often use percent max-size, which can become
   indefinite inside the reader and let images exceed the content box. */
:where(.lumi-content) img, :where(.lumi-content) svg, :where(.lumi-content) video, :where(.lumi-content) audio {
  max-width: var(--lumi-cw, 100%) !important;
  max-height: var(--lumi-ch, 100%) !important;
  object-fit: contain;
}
:where(.lumi-content) p:has(img), :where(.lumi-content) p:has(svg), :where(.lumi-content) p:has(video) {
  text-align: center;
}
:where(.lumi-content) a { color: inherit; text-decoration: underline; text-decoration-color: var(--reader-link); }

/* Image-only chapters: pixel-based maxes (percent ones degrade to "none" when the
   parent's block-size is indefinite, e.g. inside multicol/grid). */
:where(.lumi-image-only) {
  display: grid;
  place-content: center;
  min-height: var(--lumi-ch, 100%);
  writing-mode: horizontal-tb;
}
:where(.lumi-image-only) img, :where(.lumi-image-only) svg, :where(.lumi-image-only) video, :where(.lumi-image-only) audio {
  max-width: var(--lumi-cw, 100%) !important;
  max-height: var(--lumi-ch, 100%) !important;
}
.lumi-token {
  cursor: pointer;
  transition: background 0.15s ease;
}
.lumi-token:hover {
  background: color-mix(in srgb, var(--reader-fg) 8%, transparent);
}
.lumi-token-selected {
  background: color-mix(in srgb, var(--reader-fg) 15%, transparent);
}
/* Reader highlights, painted via the CSS Custom Highlight API (no DOM mutation, so token spans are untouched). Single color for now. */
::highlight(lumi-highlight) {
  background-color: color-mix(in srgb, var(--reader-accent, #5b6cb0) 42%, transparent);
}
`;

// Loaded AFTER EPUB CSS. User reader settings must win over publisher body/p sizes; otherwise changing
// font size can rerender without changing text.
export const USER_CSS = `
:where(.lumi-content) {
  font-size: var(--reader-font-size, 17px) !important;
  line-height: var(--reader-line-height, 1.7) !important;
}
:where(.lumi-reader-font-override),
.lumi-reader-font-override :where(p, li, blockquote, span, div, h1, h2, h3, h4, h5, h6, td, th, a, ruby, rt, rp) {
  font-family: var(--reader-font-family) !important;
}
/* Do NOT use a "lumi-content *" universal selector here. EPUBs may include SVG, MathML, and unusual embedded structures; a
   universal selector would recolor internals too aggressively. This targeted list catches normal prose
   nodes while leaving complex embedded content alone. */
.lumi-force-colors,
.lumi-force-colors p,
.lumi-force-colors li,
.lumi-force-colors blockquote,
.lumi-force-colors span,
.lumi-force-colors div,
.lumi-force-colors h1,
.lumi-force-colors h2,
.lumi-force-colors h3,
.lumi-force-colors h4,
.lumi-force-colors h5,
.lumi-force-colors h6,
.lumi-force-colors td,
.lumi-force-colors th,
.lumi-force-colors a {
  color: var(--reader-fg) !important;
}
:where(.lumi-content p, .lumi-content li, .lumi-content blockquote, .lumi-content td, .lumi-content th) {
  font-size: inherit !important;
  line-height: inherit !important;
}
`;

// Reuse the reader-owned sheets across shadow roots so host/user CSS isn't reparsed on every render.
export const READER_SHARED_SHEETS: CSSStyleSheet[] | null =
  typeof CSSStyleSheet !== "undefined" &&
  typeof ShadowRoot !== "undefined" &&
  "replaceSync" in CSSStyleSheet.prototype &&
  "adoptedStyleSheets" in ShadowRoot.prototype
    ? (() => {
        const hostSheet = new CSSStyleSheet();
        hostSheet.replaceSync(HOST_CSS);
        const userSheet = new CSSStyleSheet();
        userSheet.replaceSync(USER_CSS);
        return [hostSheet, userSheet];
      })()
    : null;
