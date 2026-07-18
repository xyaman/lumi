// ZIP読み込みとOPF/nav解析の基本動作。

import "./helpers/dom.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EpubParseError, openZip, parseEpub } from "../src/index.js";
import { buildZip, makeEpub, xhtml } from "./helpers/make-epub.js";

const encoder = new TextEncoder();

const simple = () =>
  makeEpub({
    files: { "c1.xhtml": xhtml("<p>あいうえお</p>") },
    manifest: [{ id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" }],
    spine: [{ idref: "c1" }],
  });

describe("parseEpub", () => {
  it("parses a minimal EPUB", async () => {
    const epub = await parseEpub(simple());
    assert.equal(epub.meta.title, "テスト");
    assert.equal(epub.meta.language, "ja");
    assert.equal(epub.meta.pageProgressionDirection, "rtl");
    assert.equal(epub.spine.length, 1);
    assert.ok(epub.resources.has("OEBPS/c1.xhtml"));
    // navもNCXも無い最小構成なので目次不在の警告だけが出る。
    assert.deepEqual(
      epub.warnings.map((w) => w.kind),
      ["missing-nav-document"],
    );
  });

  it("inflates resources lazily and correctly", async () => {
    const epub = await parseEpub(simple());
    const bytes = await epub.resources.get("OEBPS/c1.xhtml")!.load();
    assert.match(new TextDecoder().decode(bytes), /あいうえお/);
  });

  it("rejects a non-ZIP file", async () => {
    await assert.rejects(() => parseEpub(new Blob([encoder.encode("not a zip")])), EpubParseError);
  });

  it("rejects a ZIP without the mimetype entry", async () => {
    const zip = buildZip([{ name: "hello.txt", data: encoder.encode("hi") }]);
    await assert.rejects(() => parseEpub(zip), (e: EpubParseError) => e.kind === "missing-mimetype");
  });

  it("rejects a wrong mimetype", async () => {
    const zip = buildZip([{ name: "mimetype", data: encoder.encode("application/zip") }]);
    await assert.rejects(() => parseEpub(zip), (e: EpubParseError) => e.kind === "wrong-mimetype");
  });

  it("accepts a valid mimetype entry even when a non-conforming producer did not put it first", async () => {
    const zip = buildZip([
      { name: "other", data: encoder.encode("x") },
      { name: "mimetype", data: encoder.encode("application/epub+zip") },
    ]);
    const archive = await openZip(zip);
    assert.equal(new TextDecoder().decode(await archive.read("other")), "x");
  });

  it("rejects duplicate ZIP entry names", async () => {
    const zip = buildZip([
      { name: "mimetype", data: encoder.encode("application/epub+zip") },
      { name: "mimetype", data: encoder.encode("application/epub+zip") },
    ]);
    await assert.rejects(() => parseEpub(zip), (error: unknown) => {
      assert.ok(error instanceof EpubParseError);
      assert.equal(error.kind, "not-zip");
      return true;
    });
  });

  it("reads the EPUB3 nav document", async () => {
    const epub = await parseEpub(
      makeEpub({
        files: { "c1.xhtml": xhtml("<p>本文</p>") },
        manifest: [{ id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" }],
        spine: [{ idref: "c1" }],
        nav: `<ol><li><a href="c1.xhtml#top">第一章</a></li></ol>`,
      }),
    );
    assert.equal(epub.nav.length, 1);
    assert.equal(epub.nav[0].label, "第一章");
    assert.equal(epub.nav[0].href, "OEBPS/c1.xhtml#top");
  });

  it("falls back to the EPUB2 NCX", async () => {
    const epub = await parseEpub(
      makeEpub({
        version: "2.0",
        files: { "c1.xhtml": xhtml("<p>本文</p>") },
        manifest: [{ id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" }],
        spine: [{ idref: "c1" }],
        ncx: `<navPoint id="n1"><navLabel><text>序章</text></navLabel><content src="c1.xhtml"/></navPoint>`,
      }),
    );
    assert.equal(epub.nav.length, 1);
    assert.equal(epub.nav[0].label, "序章");
    assert.equal(epub.nav[0].href, "OEBPS/c1.xhtml");
  });

  it("falls back to NCX when the declared EPUB3 TOC is empty", async () => {
    const epub = await parseEpub(
      makeEpub({
        files: { "c1.xhtml": xhtml("<p>本文</p>") },
        manifest: [{ id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" }],
        spine: [{ idref: "c1" }],
        nav: "<ol></ol>",
        ncx: '<navPoint id="n1"><navLabel><text>NCX chapter</text></navLabel><content src="c1.xhtml"/></navPoint>',
      }),
    );
    assert.equal(epub.nav[0]?.label, "NCX chapter");
  });

  it("blocks zip-slip hrefs in the nav document", async () => {
    const epub = await parseEpub(
      makeEpub({
        files: { "c1.xhtml": xhtml("<p>本文</p>") },
        manifest: [{ id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" }],
        spine: [{ idref: "c1" }],
        nav: `<ol><li><a href="../../etc/passwd">悪意</a></li></ol>`,
      }),
    );
    assert.ok(epub.warnings.some((w) => w.kind === "zip-slip-blocked"));
    assert.deepEqual(epub.nav, []);
  });

  it("defaults rendition:spread and layout when absent", async () => {
    const epub = await parseEpub(simple());
    assert.equal(epub.meta.spread, "auto");
    assert.equal(epub.meta.layout, "reflowable");
  });

  it("parses each rendition:spread value", async () => {
    for (const v of ["auto", "none", "landscape", "portrait", "both"] as const) {
      const epub = await parseEpub(
        makeEpub({
          files: { "c1.xhtml": xhtml("<p>本文</p>") },
          manifest: [{ id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" }],
          spine: [{ idref: "c1" }],
          spread: v,
        }),
      );
      assert.equal(epub.meta.spread, v);
    }
  });

  it("falls back to auto for an unknown rendition:spread value", async () => {
    const epub = await parseEpub(
      makeEpub({
        files: { "c1.xhtml": xhtml("<p>本文</p>") },
        manifest: [{ id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" }],
        spine: [{ idref: "c1" }],
        spread: "sideways",
      }),
    );
    assert.equal(epub.meta.spread, "auto");
  });

  it("still reads rendition:layout at the book level", async () => {
    const epub = await parseEpub(
      makeEpub({
        files: { "c1.xhtml": xhtml("<p>本文</p>") },
        manifest: [{ id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" }],
        spine: [{ idref: "c1" }],
        layout: "pre-paginated",
      }),
    );
    assert.equal(epub.meta.layout, "pre-paginated");
  });

  it("survives a malformed nav document without throwing", async () => {
    const epub = await parseEpub(
      makeEpub({
        files: {
          "c1.xhtml": xhtml("<p>本文</p>"),
          "nav.xhtml": "<html><body><nav>unclosed",
        },
        manifest: [
          { id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" },
          { id: "nav", href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: "nav" },
        ],
        spine: [{ idref: "c1" }],
      }),
    );
    assert.deepEqual(epub.nav, []);
    assert.ok(epub.warnings.some((w) => w.kind === "invalid-nav-xml"));
  });
});
