import type { WarningCollector } from "./errors";
import type { Landmark, NavPoint } from "./types";
import { dirname, resolveHref } from "./utils";
import { directChildren, findElement, findElements, NS, parseXml, textOf } from "./xml";

/** TOC + landmarks parsed from a single nav document. */
export type NavResult = {
  toc: NavPoint[];
  /** EPUB 3 landmarks; empty array when absent. */
  landmarks: Landmark[];
};

/** Parse an EPUB 3 nav document. TOC and landmarks live in the same DOM, so a single XML parse covers both. */
export function parseNav(text: string, navPath: string, warn: WarningCollector): NavResult {
  let doc: Document;
  try {
    doc = parseXml(text, "invalid-nav-xml", navPath);
  } catch {
    warn.add(
      "invalid-nav-xml",
      `The navigation document \`${navPath}\` is not valid XML. Falling back to no TOC.`,
      navPath,
    );
    return { toc: [], landmarks: [] };
  }

  const baseDir = dirname(navPath);
  const navs = findElements(doc, NS.xhtml, "nav");

  const tocNav = navs.find((n) => navType(n) === "toc");
  const lmNav = navs.find((n) => navType(n) === "landmarks");

  // Per spec, each <nav>'s content is its first <ol>.
  const tocOl = tocNav && directChildren(tocNav, NS.xhtml, "ol")[0];
  const lmOl = lmNav && directChildren(lmNav, NS.xhtml, "ol")[0];

  if (tocNav && !tocOl) {
    warn.add(
      "invalid-nav-structure",
      `<nav epub:type="toc"> in \`${navPath}\` has no <ol> child; TOC will be empty.`,
      navPath,
    );
  }

  return {
    toc: tocOl ? walkNavList(tocOl, baseDir, warn, navPath) : [],
    landmarks: lmOl ? walkLandmarks(lmOl, baseDir, warn, navPath) : [],
  };
}

/** Read `epub:type` from a `<nav>` or anchor (falls back to the literal attribute name if the prefix is undeclared). */
function navType(el: Element): string | null {
  return el.getAttributeNS(NS.epub, "type") ?? el.getAttribute("epub:type");
}

// Descend through <li> children but skip nested <ol>s so a parent's link isn't shadowed by its descendants.
function findAnchor(el: Element): Element | null {
  const direct = directChildren(el, NS.xhtml, "a")[0];
  if (direct) return direct;

  for (const child of Array.from(el.children)) {
    if (child.localName === "ol") continue;
    const nested = findAnchor(child);
    if (nested) return nested;
  }
  return null;
}

function walkNavList(ol: Element, baseDir: string, warn: WarningCollector, navPath: string): NavPoint[] {
  const out: NavPoint[] = [];
  for (const li of directChildren(ol, NS.xhtml, "li")) {
    const anchor = findAnchor(li) ?? directChildren(li, NS.xhtml, "span")[0];
    const rawHref = anchor?.getAttribute("href") ?? "";
    const childOl = directChildren(li, NS.xhtml, "ol")[0];

    const point: NavPoint = {
      label: textOf(anchor) ?? "",
      href: resolveNavHref(baseDir, rawHref, warn, navPath),
      children: childOl ? walkNavList(childOl, baseDir, warn, navPath) : [],
    };
    if (point.label || point.children.length > 0) out.push(point);
  }
  return out;
}

function walkLandmarks(ol: Element, baseDir: string, warn: WarningCollector, navPath: string): Landmark[] {
  const out: Landmark[] = [];
  for (const li of directChildren(ol, NS.xhtml, "li")) {
    const a = directChildren(li, NS.xhtml, "a")[0];
    if (!a) continue;
    const type = navType(a) ?? "";
    const rawHref = a.getAttribute("href") ?? "";
    // A landmark with no type or href carries no meaning.
    if (!type || !rawHref) continue;
    const href = resolveNavHref(baseDir, rawHref, warn, navPath);
    if (!href) continue;
    out.push({ type, label: textOf(a) ?? "", href });
  }
  return out;
}

/** Parse an EPUB 2 NCX file (TOC only). */
export function parseNcx(text: string, ncxPath: string, warn: WarningCollector): NavPoint[] {
  let doc: Document;
  try {
    doc = parseXml(text, "invalid-ncx-xml", ncxPath);
  } catch {
    warn.add("invalid-ncx-xml", `The NCX file \`${ncxPath}\` is not valid XML. Falling back to no TOC.`, ncxPath);
    return [];
  }

  const navMap = findElement(doc, NS.ncx, "navMap");
  return navMap ? walkNavPoints(navMap, dirname(ncxPath), warn, ncxPath) : [];
}

function walkNavPoints(parent: Element, baseDir: string, warn: WarningCollector, ncxPath: string): NavPoint[] {
  const out: NavPoint[] = [];
  for (const point of directChildren(parent, NS.ncx, "navPoint")) {
    const text = findElement(findElement(point, NS.ncx, "navLabel"), NS.ncx, "text");
    const rawHref = findElement(point, NS.ncx, "content")?.getAttribute("src") ?? "";

    out.push({
      label: textOf(text) ?? "",
      href: resolveNavHref(baseDir, rawHref, warn, ncxPath),
      children: walkNavPoints(point, baseDir, warn, ncxPath),
    });
  }
  return out;
}

/** Resolve a nav href against `baseDir`, preserving any `#fragment`. Returns `""` and warns on zip-slip. */
function resolveNavHref(baseDir: string, rawHref: string, warn: WarningCollector, navPath: string): string {
  if (!rawHref) return "";
  const fragIdx = rawHref.indexOf("#");
  const path = fragIdx === -1 ? rawHref : rawHref.slice(0, fragIdx);
  const resolved = resolveHref(baseDir, path);
  if (resolved === undefined) {
    warn.add("zip-slip-blocked", `Nav entry href escapes the package root: "${rawHref}".`, navPath);
    return "";
  }
  return fragIdx === -1 ? resolved : `${resolved}${rawHref.slice(fragIdx)}`;
}
