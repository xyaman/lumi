// Node/Bun DOM polyfill for tests, backed by @xmldom/xmldom. Patches two
// xmldom/browser differences: throws on malformed XML (we return a
// <parsererror> document) and lacks querySelector (we install a tag shim).

import { DOMParser as XmldomParser, XMLSerializer as XmldomSerializer } from "@xmldom/xmldom";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

// querySelector/querySelectorAll shim. Supports a tag name or "*" only.
function installSelectors(doc: Document): void {
  const anyDoc = doc as unknown as {
    querySelector?: unknown;
    querySelectorAll?: unknown;
    getElementsByTagName(name: string): { length: number; [i: number]: Element };
  };
  if (typeof anyDoc.querySelector === "function") return;

  const matchAll = (selector: string): Element[] => {
    const sel = selector.trim();
    const tag = /^[A-Za-z][\w:-]*$/.test(sel) ? sel : "*";
    const list = anyDoc.getElementsByTagName(tag);
    return Array.from({ length: list.length }, (_, i) => list[i]);
  };

  Object.defineProperty(anyDoc, "querySelector", {
    value: (selector: string): Element | null => matchAll(selector)[0] ?? null,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(anyDoc, "querySelectorAll", {
    value: (selector: string): Element[] => matchAll(selector),
    configurable: true,
    writable: true,
  });
}

// Node DOMParser implementation.
class NodeDOMParser {
  parseFromString(source: string, mimeType: string): Document {
    let doc: Document;
    try {
      doc = new XmldomParser().parseFromString(source, mimeType) as unknown as Document;
    } catch (err) {
      // Convert xmldom's throw into a <parsererror> document detectable via selector.
      const message = err instanceof Error ? err.message : String(err);
      const fallback = new XmldomParser().parseFromString(
        `<parsererror xmlns="${XHTML_NS}"></parsererror>`,
        "application/xml",
      ) as unknown as Document & {
        getElementsByTagName(name: string): { [i: number]: { textContent?: string }; length: number };
      };
      const node = fallback.getElementsByTagName("parsererror")[0];
      if (node) node.textContent = message;
      doc = fallback;
    }
    installSelectors(doc);
    return doc;
  }
}

// Register globals only when the native ones are absent (no-op in the browser).
if (typeof globalThis.DOMParser === "undefined") {
  (globalThis as unknown as { DOMParser: typeof NodeDOMParser }).DOMParser = NodeDOMParser;
}
if (typeof globalThis.XMLSerializer === "undefined") {
  (globalThis as unknown as { XMLSerializer: typeof XmldomSerializer }).XMLSerializer = XmldomSerializer;
}

export { NodeDOMParser };
