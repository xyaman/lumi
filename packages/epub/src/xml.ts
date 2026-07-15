// The native DOMParser is available everywhere EPUB parsing runs; no dependency.

import { fail } from "./errors";
import type { ErrorKind } from "./types";

/** EPUB-relevant XML namespaces used by `findElement`/`findElements`/etc. */
export const NS = {
  ocf: "urn:oasis:names:tc:opendocument:xmlns:container",
  opf: "http://www.idpf.org/2007/opf",
  dc: "http://purl.org/dc/elements/1.1/",
  xhtml: "http://www.w3.org/1999/xhtml",
  epub: "http://www.idpf.org/2007/ops",
  ncx: "http://www.daisy.org/z3986/2005/ncx/",
} as const;

/** Parse `text` in strict XML mode. Throws with `errorKind` on malformed input. */
export function parseXml(text: string, errorKind: ErrorKind, path: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  // DOMParser reports errors as <parsererror>, not exceptions.
  const err = doc.querySelector("parsererror");
  if (err) {
    fail(errorKind, `The file \`${path}\` is not valid XML.`, { path, cause: err.textContent ?? undefined });
  }
  return doc;
}

/** First descendant of `parent` matching `(namespace, localName)`. Accepts `undefined` for chainable searches. */
export function findElement(
  parent: Element | Document | undefined,
  ns: string,
  localName: string,
): Element | undefined {
  if (!parent) return undefined;
  const list = parent.getElementsByTagNameNS(ns, localName);
  return list.length ? list[0] : undefined;
}

/** All descendants matching `(namespace, localName)` as a real array (not a live HTMLCollection). */
export function findElements(parent: Element | Document, ns: string, localName: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(ns, localName));
}

/** Trimmed text contents of each matching descendant. Empty entries are dropped. */
export function findTexts(parent: Element | Document, ns: string, localName: string): string[] {
  const out: string[] = [];
  for (const el of parent.getElementsByTagNameNS(ns, localName)) {
    const t = el.textContent?.trim();
    if (t) out.push(t);
  }
  return out;
}

/** Direct children (depth 1) matching `(namespace, localName)`. Some EPUB structures only care about depth 1. */
export function directChildren(parent: Element, ns: string, localName: string): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(parent.children)) {
    if (c.namespaceURI === ns && c.localName === localName) out.push(c);
  }
  return out;
}

/** Trimmed text content; `undefined` when absent or empty. */
export function textOf(el: Element | undefined): string | undefined {
  const t = el?.textContent?.trim();
  return t ? t : undefined;
}
