import "./helpers/dom.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Epub, Resource } from "@lostcoords/lumi-epub";
import { createBlobUrlStore, loadSpineDocument, processCssText, rewriteResourceUrls } from "../src/index.js";

const encoder = new TextEncoder();

function epubWith(files: Record<string, { text: string; mediaType: string }>): Epub {
  const resources = new Map<string, Resource>();
  for (const [href, file] of Object.entries(files)) {
    const bytes = encoder.encode(file.text);
    resources.set(href, {
      href,
      mediaType: file.mediaType,
      size: bytes.length,
      load: async () => bytes,
    });
  }
  return {
    meta: { language: "ja" } as Epub["meta"],
    manifest: new Map(),
    spine: [],
    nav: [],
    landmarks: [],
    resources,
    rootDir: "OEBPS",
    warnings: [],
  };
}

describe("spine document isolation", () => {
  it("removes active markup and event handlers", async () => {
    (window as Window & { __lumiExecuted?: boolean }).__lumiExecuted = false;
    const epub = epubWith({
      "OEBPS/c.xhtml": {
        mediaType: "application/xhtml+xml",
        text:
          '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>' +
          '<form action="https://bad.test"><p onclick="steal()">before-after</p><button formaction="https://bad.test">go</button></form>' +
          '<script>window.__lumiExecuted = true</script><link rel="stylesheet" href="https://bad.test/x.css"/>' +
          "</body></html>",
      },
    });
    const loaded = await loadSpineDocument("OEBPS/c.xhtml", epub);
    assert.ok(loaded);
    assert.equal(loaded.doc.querySelector("script, link, form"), null);
    assert.equal(loaded.bodyEl.querySelector("p")?.hasAttribute("onclick"), false);
    assert.equal(loaded.bodyEl.querySelector("button")?.hasAttribute("formaction"), false);
    assert.equal(loaded.bodyEl.textContent, "before-aftergo");
    assert.equal((window as Window & { __lumiExecuted?: boolean }).__lumiExecuted, false);
  });

  it("rewrites archive media and removes remote media URLs", async () => {
    const epub = epubWith({
      "OEBPS/image.png": { mediaType: "image/png", text: "png" },
    });
    const doc = new DOMParser().parseFromString(
      '<html><body><img id="local" src="image.png"/><img id="remote" src="https://bad.test/x.png"/><video poster="//bad.test/p.jpg"/></body></html>',
      "text/html",
    );
    const urls = createBlobUrlStore();
    await rewriteResourceUrls(doc, epub, "OEBPS", urls);
    assert.match(doc.querySelector("#local")?.getAttribute("src") ?? "", /^blob:/);
    assert.equal(doc.querySelector("#remote")?.hasAttribute("src"), false);
    assert.equal(doc.querySelector("video")?.hasAttribute("poster"), false);
    for (const url of urls.urls) URL.revokeObjectURL(url);
  });
});

describe("publisher CSS isolation", () => {
  it("preserves import media conditions and blocks remote URLs", async () => {
    const epub = epubWith({
      "OEBPS/print.css": { mediaType: "text/css", text: "body { color: black }" },
    });
    const css = await processCssText(
      '@import "print.css" print; @IMPORT url("https://bad.test/a b.css"); body { background: url(https://bad.test/pixel); cursor: url("https://bad.test/a b.cur") }',
      "OEBPS",
      epub,
      new Set(),
      [],
    );
    assert.match(css, /@media print/);
    assert.match(css, /\.lumi-content/);
    assert.doesNotMatch(css, /bad\.test/);
    assert.match(css, /data:,/);
  });
});
