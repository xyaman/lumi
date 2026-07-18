// Convert spine items into Sections (render units addressed by atom offset).
// Atom rules: 1 atom per code point in non-whitespace-only text nodes, 1 per replaced element (img/svg/image/video/audio),
// skipping rt/rp/script/style. Any renderer mapping atoms → layout must mirror this walk.

import type { Book, Chapter, Direction, Epub, EpubMetadata, NavPoint, Section } from "./types";
import { fail } from "./errors";
import { dirname, resolveHref } from "./utils";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

/** Replaced elements: 1 atom each, subtree not walked. */
const REPLACED = new Set(["img", "svg", "image", "video", "audio"]);

/** Skipped elements: ruby annotations (not part of reading order) and script/style (neither prose nor rendered). */
const SKIPPED = new Set(["rt", "rp", "script", "style"]);

/** Elements ignored when deciding whether a section is image-only. */
const IMAGE_ONLY_IGNORED = new Set(["head", "title", "style", "script"]);

/** Media types treated as content documents in the spine. */
const CONTENT_TYPES = new Set(["application/xhtml+xml", "text/html"]);

/** Resolve `manifestId` to a content-document href, following the fallback chain. */
function resolveContentHref(epub: Epub, manifestId: string): string | undefined {
  const seen = new Set<string>();
  let id: string | undefined = manifestId;

  while (id && !seen.has(id)) {
    seen.add(id);
    const item = epub.manifest.get(id);
    if (!item) return undefined;
    if (CONTENT_TYPES.has(item.mediaType)) return item.href;
    id = item.fallback;
  }
  return undefined;
}

function localName(el: Element): string {
  return (el.localName ?? el.nodeName).toLowerCase();
}

function firstChildTag(doc: Document, tag: string): Element | null {
  const list = doc.getElementsByTagName(tag);
  return list.length > 0 ? (list[0] as Element) : null;
}

// Inter-block whitespace is XHTML indentation (collapsed by HTML rendering); skip it so atom counts don't vary with formatting.
function isWhitespaceOnly(text: string): boolean {
  return !/\S/.test(text);
}

function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++, count++) {
    const first = text.charCodeAt(i);
    if (first >= 0xd800 && first <= 0xdbff && i + 1 < text.length) {
      const second = text.charCodeAt(i + 1);
      if (second >= 0xdc00 && second <= 0xdfff) i++;
    }
  }
  return count;
}

/** Detect the section's writing direction from html/body classes (returns null to defer to the book default). */
function detectDirection(doc: Document, body: Element): Direction | null {
  const html = doc.documentElement;
  const classes = `${html?.getAttribute("class") ?? ""} ${body.getAttribute("class") ?? ""}`;
  if (/\bvrtl\b/.test(classes)) return "vertical";
  if (/\bhltr\b/.test(classes)) return "horizontal";
  return null;
}

/** Forced spread side from spine item properties (null when auto). */
function detectForcedSide(props: Set<string>): Section["forcedSide"] {
  if (props.has("page-spread-right")) return "right";
  if (props.has("page-spread-left")) return "left";
  if (props.has("page-spread-center") || props.has("rendition:page-spread-center")) return "center";
  return null;
}

/** Resolve itemref rendition:layout-* over the book default. */
function resolveLayout(props: Set<string>, bookDefault: EpubMetadata["layout"]): Section["layout"] {
  if (props.has("rendition:layout-pre-paginated")) return "pre-paginated";
  if (props.has("rendition:layout-reflowable")) return "reflowable";
  return bookDefault;
}

/** Resolve itemref rendition:spread-* over the book default. `page-spread-center` is a forced side, not a policy. */
function resolveSpreadPolicy(props: Set<string>, bookDefault: EpubMetadata["spread"]): Section["spreadPolicy"] {
  if (props.has("rendition:spread-none")) return "none";
  if (props.has("rendition:spread-auto")) return "auto";
  if (props.has("rendition:spread-landscape")) return "landscape";
  if (props.has("rendition:spread-portrait")) return "portrait";
  if (props.has("rendition:spread-both")) return "both";
  return bookDefault;
}

/** True when the section contains at least one replaced element and no text. */
function isImageOnly(body: Element): boolean {
  let images = 0;
  let hasText = false;

  const walk = (node: Node): void => {
    if (hasText) return;
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i] as Node;
      if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_NODE) {
        if (!isWhitespaceOnly(child.nodeValue ?? "")) hasText = true;
      } else if (child.nodeType === ELEMENT_NODE) {
        const tag = localName(child as Element);
        if (IMAGE_ONLY_IGNORED.has(tag)) continue;
        if (REPLACED.has(tag)) {
          images++;
          continue;
        }
        walk(child);
      }
      if (hasText) return;
    }
  };

  walk(body);
  return images > 0 && !hasText;
}

/** Walk `body` in document order, assigning atom offsets. Renderer mirrors this to map atoms to layout. */
function walkAtoms(body: Element, ids: Map<string, number>): number {
  let offset = 0;

  const bodyId = body.getAttribute("id");
  if (bodyId) ids.set(bodyId, 0);

  const visit = (node: Node): void => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i] as Node;

      if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_NODE) {
        const text = child.nodeValue ?? "";
        // Count by code point, not UTF-16 unit.
        if (!isWhitespaceOnly(text)) offset += codePointLength(text);
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue;

      const el = child as Element;
      const tag = localName(el);
      if (SKIPPED.has(tag)) continue;

      const id = el.getAttribute("id");
      if (id) ids.set(id, offset);

      if (REPLACED.has(tag)) {
        offset += 1;
        continue;
      }
      visit(el);
    }
  };

  visit(body);
  return offset;
}

/** ZIP-absolute paths of stylesheets this section links from `<head>` (deduplicated, order preserved; only `rel="stylesheet"`). */
function collectCssHrefs(doc: Document, epub: Epub, sectionHref: string): string[] {
  const head = doc.getElementsByTagName("head")[0] as Element | undefined;
  if (!head) return [];

  const baseDir = dirname(sectionHref);
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < head.childNodes.length; i++) {
    const child = head.childNodes[i] as Node;
    if (child.nodeType !== ELEMENT_NODE) continue;
    const el = child as Element;
    if (localName(el) !== "link") continue;

    const rel = (el.getAttribute("rel") ?? "").trim().toLowerCase();
    if (rel !== "stylesheet") continue; // excludes alternate stylesheets

    const href = el.getAttribute("href");
    if (!href) continue;

    const abs = resolveHref(baseDir, href);
    if (!abs || !epub.resources.has(abs) || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/** Convert every linear spine item into a `Section`, assigning atom offsets in reading order. */
export async function buildSections(epub: Epub): Promise<Section[]> {
  const sections: Section[] = [];
  let atom = 0;

  for (let i = 0; i < epub.spine.length; i++) {
    const item = epub.spine[i];
    if (!item.linear) continue;

    const href = resolveContentHref(epub, item.manifestId);
    if (!href) continue;

    const res = epub.resources.get(href);
    if (!res) {
      epub.warnings.push({
        kind: "missing-spine-resource",
        message: `Linear spine resource \`${href}\` is missing from the archive.`,
        path: href,
      });
      continue;
    }

    const html = new TextDecoder().decode(await res.load());
    const parser = new DOMParser();
    let doc = parser.parseFromString(html, "application/xhtml+xml");
    if (doc.querySelector("parsererror")) doc = parser.parseFromString(html, "text/html");

    const body = firstChildTag(doc, "body");
    if (!body) {
      epub.warnings.push({
        kind: "invalid-content-document",
        message: `Spine resource \`${href}\` has no renderable body and was skipped.`,
        path: href,
      });
      continue;
    }

    const ids = new Map<string, number>();
    const count = walkAtoms(body, ids);

    const imgOnly = isImageOnly(body);

    sections.push({
      spineIndex: sections.length,
      epubSpineIndex: i,
      href,
      startAtom: atom,
      endAtom: atom + count,
      direction: detectDirection(doc, body),
      forcedSide: detectForcedSide(item.properties),
      layout: resolveLayout(item.properties, epub.meta.layout),
      spreadPolicy: resolveSpreadPolicy(item.properties, epub.meta.spread),
      isImageOnly: imgOnly,
      ids,
      cssHrefs: collectCssHrefs(doc, epub, href),
      htmlClass: doc.documentElement?.getAttribute("class") ?? "",
      bodyClass: body.getAttribute("class") ?? "",
    });
    atom += count;
  }

  return sections;
}

/** Splits `path#fragment`. */
type HrefParts = {
  path: string; // portion before '#'
  fragment?: string; // portion after '#', omitted when no fragment
};

/** Split a href at `#`. `resolveHref` strips the fragment, so callers split it off first. */
function splitFragment(href: string): HrefParts {
  const i = href.indexOf("#");
  return i === -1 ? { path: href } : { path: href.slice(0, i), fragment: href.slice(i + 1) };
}

/** Resolve the navigation tree into a chapter tree keyed to `Section`s. */
export function buildChapters(epub: Epub, sections: Section[], nav: NavPoint[]): Chapter[] {
  const byHref = new Map<string, Section>();
  for (const s of sections) {
    byHref.set(s.href, s);
    // Cover the case where the TOC points at the spine item rather than the fallback-resolved content doc.
    byHref.set(epub.spine[s.epubSpineIndex].href, s);
  }

  const convert = (point: NavPoint): Chapter => {
    const { path, fragment } = splitFragment(point.href);
    const section = path ? byHref.get(path) : undefined;
    const children = point.children.map(convert);

    // No href (group heading) or a target outside the linear spine. Keep the node either way so its children stay reachable.
    if (!section) return { label: point.label, children };

    return {
      label: point.label,
      target: {
        spineIndex: section.spineIndex,
        // Unresolvable fragment = the id was absent in the section. Section start is a safe fallback.
        offset: (fragment ? section.ids.get(fragment) : undefined) ?? 0,
      },
      children,
    };
  };

  return nav.map(convert);
}

/** Convert an `Epub` into a `Book` with section + chapter structure. */
export async function buildBook(id: string, epub: Epub): Promise<Book> {
  const sections = await buildSections(epub);
  if (sections.length === 0) {
    fail("no-spine-items", "The EPUB has no renderable linear spine documents.");
  }
  return {
    id,
    epub,
    sections,
    chapters: buildChapters(epub, sections, epub.nav),
    pageProgressionDirection: epub.meta.pageProgressionDirection,
    totalAtoms: sections.length > 0 ? sections[sections.length - 1].endAtom : 0,
    parsedAt: Date.now(),
  };
}
