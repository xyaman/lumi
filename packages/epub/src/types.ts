/** Parsed EPUB document. */
export type Epub = {
  meta: EpubMetadata;
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[]; // linear=false items included
  nav: NavPoint[];
  landmarks: Landmark[];
  resources: Map<string, Resource>; // keyed by ZIP-absolute path
  rootDir: string; // OPF directory inside the ZIP
  warnings: EpubWarning[];
};

export type EpubMetadata = {
  title: string;
  titles: string[]; // all <dc:title> values, in document order
  creator: string[];
  language: string; // first <dc:language>
  identifier: string;
  identifiers: {
    isbn10?: string;
    isbn13?: string;
    asin?: string;
    uuid?: string;
    primary?: string;
  };
  publisher?: string;
  description?: string;
  date?: string;
  direction: "ltr" | "rtl";
  layout: "reflowable" | "pre-paginated";
  spread: "auto" | "none" | "landscape" | "portrait" | "both";
  coverHref?: string; // ZIP-absolute path
  epubVersion: "2.0" | "3.0" | "3.1" | "3.2" | "3.3" | string;
};

export type ManifestItem = {
  id: string;
  href: string; // ZIP-absolute
  mediaType: string;
  properties: Set<string>; // nav, cover-image, etc.
  fallback?: string; // id of the fallback manifest item
};

export type SpineItem = {
  manifestId: string;
  href: string; // ZIP-absolute
  linear: boolean;
  properties: Set<string>; // page-spread, rendition hints, etc.
};

export type NavPoint = {
  label: string;
  href: string; // ZIP-absolute; may carry a #fragment
  children: NavPoint[];
};

export type Landmark = {
  type: string; // epub:type value (e.g. cover, bodymatter)
  label: string;
  href: string; // may carry a #fragment
};

export type Resource = {
  href: string; // ZIP-absolute
  mediaType: string;
  size: number; // uncompressed bytes; for progress reporting
  load(): Promise<Uint8Array>; // lazy: reads from Blob on first call
};

export type Direction = "vertical" | "horizontal"; // inline progression

/** A render unit addressed by atom offset. */
export type Section = {
  spineIndex: number;
  href: string; // ZIP-absolute
  /** Book-global atom offset where this section begins. */
  startAtom: number;
  /** Book-global atom offset one past the last atom (exclusive). */
  endAtom: number;
  /** Concatenated HTML of the body children (XHTML, serialized). */
  content: string;
  /** Per-section direction override; null defers to the book default. */
  direction: Direction | null;
  /** Pin to a specific side of a two-page spread; null means auto. */
  forcedSide: "left" | "right" | "center" | null;
  layout: "reflowable" | "pre-paginated"; // itemref override resolved over the book default
  spreadPolicy: "auto" | "none" | "landscape" | "portrait" | "both"; // itemref override resolved
  isImageOnly: boolean;
  /** Fragment id → section-local atom offset. */
  ids: Map<string, number>;
  /** ZIP-absolute hrefs of linked stylesheets, in document order. */
  cssHrefs: string[];
  /** `<html>` class (empty string if absent). */
  htmlClass: string;
  /** `<body>` class (empty string if absent). */
  bodyClass: string;
};

/** One TOC entry. Not 1:1 with `Section` — a spine document can span multiple chapters. */
export type Chapter = {
  label: string;
  /** Resolved position; absent on group headings. */
  target?: { spineIndex: number; offset: number };
  children: Chapter[];
};

/** A stable reading position, durable across font / viewport / pagination changes. */
export type Position = {
  spineIndex: number;
  /** Section-local atom offset. */
  offset: number;
  fragment?: string; // id within the section
  /** Surrounding text — used to re-anchor a stale atom offset. */
  text?: { before: string; highlight: string; after: string };
};

/** Parsed EPUB + resolved sections/chapters, ready for rendering. */
export type Book = {
  id: string;
  epub: Epub; // original parse output
  sections: Section[];
  chapters: Chapter[]; // resolved TOC tree
  spineDirection: Direction;
  totalAtoms: number;
  parsedAt: number;
};

/** Error and warning kinds. `ErrorKind`s are fatal on parse; a few are also downgradable to `WarningKind`s at the caller's request. */
export type ErrorKind =
  | "not-zip"
  | "missing-mimetype"
  | "wrong-mimetype"
  | "missing-container"
  | "invalid-container-xml"
  | "missing-rootfile"
  | "missing-opf"
  | "invalid-opf-xml"
  | "invalid-nav-xml"
  | "invalid-ncx-xml"
  | "missing-required-metadata"
  | "no-spine-items";

/** Non-fatal issue kinds reported via `EpubWarning`. */
export type WarningKind =
  | "spine-idref-missing" // spine references an unknown manifest id
  | "manifest-item-missing-attr" // missing required attribute on <item>
  | "unknown-property" // unrecognized property value
  | "missing-nav-document" // no EPUB 3 nav document declared
  | "missing-ncx" // spine[toc] references a missing NCX
  | "invalid-nav-xml" // malformed nav document
  | "invalid-ncx-xml" // malformed NCX
  | "invalid-nav-structure" // nav element missing required <ol>
  | "unusable-nav-hrefs" // nav hrefs don't resolve to manifest items
  | "remote-resource" // item points outside the ZIP
  | "zip-slip-blocked" // href escapes the OPF root
  | "duplicate-manifest-id"
  | "duplicate-spine-idref";

/** Non-fatal issue encountered during parsing. */
export type EpubWarning = {
  kind: WarningKind;
  message: string;
  path?: string; // ZIP-absolute file path, when applicable
};
