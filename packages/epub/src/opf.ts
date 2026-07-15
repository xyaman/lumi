import { fail, type WarningCollector } from "./errors";
import type { EpubMetadata, ManifestItem, SpineItem } from "./types";
import { dirname, resolveHref } from "./utils";
import { findElement, findElements, findTexts, NS, parseXml, textOf } from "./xml";

/** Result of parsing the OPF package document. */
export type OpfResult = {
  meta: EpubMetadata;
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[];
  rootDir: string; // OPF directory inside the ZIP
  /** EPUB 2 NCX id (from `<spine toc="...">`); only needed for older books. */
  ncxId?: string;
  /** Manifest item id of the EPUB 3 nav document (the item with `properties="nav"`). */
  navId?: string;
};

/** `<manifest>` plus the id of the EPUB 3 nav item, if any. */
type ManifestResult = {
  manifest: Map<string, ManifestItem>;
  navId?: string;
};

/** `<spine>` plus the EPUB 2 NCX id (from `<spine toc="...">`). */
type SpineResult = {
  spine: SpineItem[];
  ncxId?: string;
};

const KNOWN_ITEM_PROPS = new Set(["cover-image", "mathml", "nav", "remote-resources", "scripted", "svg", "switch"]);

const KNOWN_SPINE_PROPS = new Set([
  "page-spread-left",
  "page-spread-right",
  "page-spread-center",
  "rendition:page-spread-center",
  "rendition:layout-pre-paginated",
  "rendition:layout-reflowable",
  "rendition:orientation-auto",
  "rendition:orientation-landscape",
  "rendition:orientation-portrait",
  "rendition:spread-auto",
  "rendition:spread-both",
  "rendition:spread-landscape",
  "rendition:spread-none",
  "rendition:spread-portrait",
]);

/** Parse the OPF package document: metadata, manifest, and spine. */
export function parseOpf(text: string, opfPath: string, warn: WarningCollector): OpfResult {
  const doc = parseXml(text, "invalid-opf-xml", opfPath);
  const pkg = findElement(doc, NS.opf, "package");
  if (!pkg) {
    fail("invalid-opf-xml", `\`${opfPath}\` does not contain a <package> root element.`, { path: opfPath });
  }

  const rootDir = dirname(opfPath);
  const epubVersion = pkg.getAttribute("version") ?? "3.0";
  const uniqueIdentifierId = pkg.getAttribute("unique-identifier") ?? undefined;

  const metadata = findElement(pkg, NS.opf, "metadata");
  if (!metadata) {
    fail("missing-required-metadata", `\`${opfPath}\` has no <metadata> section.`, { path: opfPath });
  }

  const epubMeta = parseMetadata(metadata, opfPath, uniqueIdentifierId);
  epubMeta.epubVersion = epubVersion;

  const { manifest, navId } = parseManifest(pkg, rootDir, opfPath, warn);
  const { spine, ncxId } = parseSpine(pkg, manifest, opfPath, warn);
  epubMeta.direction = readDirection(pkg);

  // rendition:layout lives inside <metadata>; reading it here lets every spine item inherit it.
  epubMeta.layout = readLayout(metadata);
  epubMeta.spread = readSpread(metadata);

  // Cover detection prefers the modern manifest property, then the legacy <meta name="cover">.
  epubMeta.coverHref = findCoverHref(metadata, manifest);

  return { meta: epubMeta, manifest, spine, rootDir, ncxId, navId };
}

function parseMetadata(metadata: Element, opfPath: string, uniqueIdentifierId: string | undefined): EpubMetadata {
  const titles = findTexts(metadata, NS.dc, "title");
  const creators = findTexts(metadata, NS.dc, "creator");
  const languages = findTexts(metadata, NS.dc, "language");
  const identifiers = findElements(metadata, NS.dc, "identifier");
  const parsedIdentifiers: EpubMetadata["identifiers"] = {};

  if (titles.length === 0 || languages.length === 0 || identifiers.length === 0) {
    const missing = [
      titles.length === 0 && "title",
      languages.length === 0 && "language",
      identifiers.length === 0 && "identifier",
    ]
      .filter(Boolean)
      .join(", ");

    fail("missing-required-metadata", `The package metadata is missing required Dublin Core elements: ${missing}.`, {
      path: opfPath,
    });
  }

  // Pick the identifier matching package/@unique-identifier; fall back to the first.
  const identifierEl = uniqueIdentifierId
    ? (identifiers.find((el) => el.getAttribute("id") === uniqueIdentifierId) ?? identifiers[0])
    : identifiers[0];
  for (const el of identifiers) {
    const text = textOf(el) ?? "";
    if (!text) continue;

    const scheme = (el.getAttributeNS(NS.opf, "scheme") ?? el.getAttribute("opf:scheme") ?? el.getAttribute("scheme"))
      ?.toLowerCase()
      .trim();
    if (scheme === "isbn" || text.startsWith("urn:isbn:")) {
      const clean = text.replace(/^urn:isbn:/i, "").replace(/[^0-9X]/gi, "");
      if (clean.length === 13) parsedIdentifiers.isbn13 ??= clean;
      if (clean.length === 10) parsedIdentifiers.isbn10 ??= clean;
    } else if (scheme === "asin" || /^B[A-Z0-9]{9}$/.test(text)) {
      parsedIdentifiers.asin ??= text;
    } else if (scheme === "uuid" || text.startsWith("urn:uuid:")) {
      parsedIdentifiers.uuid ??= text.replace(/^urn:uuid:/i, "");
    }

    parsedIdentifiers.primary ??= text;
    if (uniqueIdentifierId && el.getAttribute("id") === uniqueIdentifierId) parsedIdentifiers.primary = text;
  }

  const publisher = textOf(findElement(metadata, NS.dc, "publisher"));
  const description = textOf(findElement(metadata, NS.dc, "description"));
  const date = textOf(findElement(metadata, NS.dc, "date"));

  return {
    title: titles[0],
    titles,
    creator: creators,
    language: languages[0],
    identifier: textOf(identifierEl) ?? "",
    identifiers: parsedIdentifiers,
    publisher,
    description,
    date,
    direction: "ltr", // overwritten by readDirection()
    layout: "reflowable", // overwritten by readLayout()
    spread: "auto", // overwritten by readSpread()
    epubVersion: "3.0", // overwritten by the caller
  };
}

function parseManifest(pkg: Element, rootDir: string, opfPath: string, warn: WarningCollector): ManifestResult {
  const manifestEl = findElement(pkg, NS.opf, "manifest");
  if (!manifestEl) {
    fail("invalid-opf-xml", `\`${opfPath}\` is missing the <manifest> section.`, { path: opfPath });
  }

  const manifest = new Map<string, ManifestItem>();
  let navId: string | undefined;

  for (const itemEl of findElements(manifestEl, NS.opf, "item")) {
    const id = itemEl.getAttribute("id");
    const rawHref = itemEl.getAttribute("href");
    const mediaType = itemEl.getAttribute("media-type");

    if (!id || !rawHref || !mediaType) {
      warn.add(
        "manifest-item-missing-attr",
        "A <manifest><item> is missing one of: id, href, media-type. It will be ignored.",
        opfPath,
      );
      continue;
    }

    const resolved = resolveHref(rootDir, rawHref);
    if (resolved === undefined) {
      warn.add(
        "zip-slip-blocked",
        `Manifest item \`${id}\` has an href that escapes the package root: "${rawHref}".`,
        opfPath,
      );
      continue;
    }

    if (manifest.has(id)) {
      warn.add(
        "duplicate-manifest-id",
        `Multiple manifest items share id="${id}". Later definitions are ignored.`,
        opfPath,
      );
      continue;
    }

    const properties = parseProperties(itemEl.getAttribute("properties"), KNOWN_ITEM_PROPS, opfPath, warn);
    if (properties.has("remote-resources")) {
      warn.add(
        "remote-resource",
        `Manifest item \`${id}\` references a remote resource. It won't be cached locally.`,
        opfPath,
      );
    }

    const fallback = itemEl.getAttribute("fallback") ?? undefined;
    manifest.set(id, { id, href: resolved, mediaType, properties, fallback });
    if (properties.has("nav")) navId = id;
  }

  return { manifest, navId };
}

function parseSpine(
  pkg: Element,
  manifest: Map<string, ManifestItem>,
  opfPath: string,
  warn: WarningCollector,
): SpineResult {
  const spineEl = findElement(pkg, NS.opf, "spine");
  if (!spineEl) {
    fail("no-spine-items", `\`${opfPath}\` has no <spine> — there's nothing to read.`, { path: opfPath });
  }

  const ncxId = spineEl.getAttribute("toc") ?? undefined;
  const seenIds = new Set<string>();
  const spine: SpineItem[] = [];

  for (const itemref of findElements(spineEl, NS.opf, "itemref")) {
    const idref = itemref.getAttribute("idref");
    if (!idref) continue;

    if (seenIds.has(idref)) {
      warn.add("duplicate-spine-idref", `<itemref idref="${idref}"> appears multiple times in the spine.`, opfPath);
      continue;
    }
    seenIds.add(idref);

    const item = manifest.get(idref);
    if (!item) {
      warn.add("spine-idref-missing", `Spine references unknown manifest id "${idref}".`, opfPath);
      continue;
    }

    const linear = (itemref.getAttribute("linear") ?? "yes").toLowerCase() !== "no";
    const properties = parseProperties(itemref.getAttribute("properties"), KNOWN_SPINE_PROPS, opfPath, warn);

    spine.push({ manifestId: idref, href: item.href, linear, properties });
  }

  if (spine.length === 0) {
    fail("no-spine-items", `\`${opfPath}\` has an empty spine — there's nothing to read.`, { path: opfPath });
  }

  return { spine, ncxId };
}

/** Tokenize a `properties=` string. Unknown values warn but are kept in the set. */
function parseProperties(raw: string | null, known: Set<string>, opfPath: string, warn: WarningCollector): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;

  for (const token of raw.split(/\s+/)) {
    if (!token) continue;
    out.add(token);

    if (!known.has(token)) {
      warn.add("unknown-property", `Unrecognized property "${token}". Ignoring.`, opfPath);
    }
  }

  return out;
}

function readDirection(pkg: Element): "ltr" | "rtl" {
  const dir = findElement(pkg, NS.opf, "spine")?.getAttribute("page-progression-direction");
  return dir === "rtl" ? "rtl" : "ltr";
}

function readLayout(metadata: Element): "reflowable" | "pre-paginated" {
  const layout = findMeta(metadata, "property", "rendition:layout");
  return textOf(layout) === "pre-paginated" ? "pre-paginated" : "reflowable";
}

/** Unrecognized or absent rendition:spread values fall back to "auto". */
function readSpread(metadata: Element): EpubMetadata["spread"] {
  const value = textOf(findMeta(metadata, "property", "rendition:spread"));
  switch (value) {
    case "none":
    case "landscape":
    case "portrait":
    case "both":
      return value;
    default:
      return "auto";
  }
}

/** Resolve the cover image href. Checks EPUB 3 `cover-image` first, then legacy `<meta name="cover">`. */
function findCoverHref(metadata: Element, manifest: Map<string, ManifestItem>): string | undefined {
  // EPUB 3: a manifest item whose properties include "cover-image".
  for (const item of manifest.values()) {
    if (item.properties.has("cover-image")) return item.href;
  }
  // EPUB 2 legacy: <meta name="cover" content="<manifest-id>"/>.
  const legacy = findMeta(metadata, "name", "cover");
  const id = legacy?.getAttribute("content");
  return id ? manifest.get(id)?.href : undefined;
}

/** First descendant <opf:meta> matching the given attribute + value. */
function findMeta(metadata: Element, attr: "property" | "name", value: string): Element | undefined {
  for (const el of metadata.getElementsByTagNameNS(NS.opf, "meta")) {
    if (el.getAttribute(attr) === value) return el;
  }
  return undefined;
}
