// 原子オフセット・フラグメントID・チャプタ構築の回帰テスト。

import "./helpers/dom.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBook, parseEpub } from "../src/index.js";
import { makeEpub, xhtml } from "./helpers/make-epub.js";

// 単一のXHTMLからなるEPUBを組み立ててBookにする。
async function bookOf(body: string, opts: Parameters<typeof xhtml>[1] = {}) {
  const epub = await parseEpub(
    makeEpub({
      files: { "c1.xhtml": xhtml(body, opts) },
      manifest: [{ id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" }],
      spine: [{ idref: "c1" }],
    }),
  );
  return buildBook("t", epub);
}

const atomsOf = async (body: string) => (await bookOf(body)).totalAtoms;

describe("atom counting", () => {
  it("counts base text by code point", async () => {
    assert.equal(await atomsOf("<p>あいうえお</p>"), 5);
  });

  it("counts astral code points as one atom each", async () => {
    // 𠮟 はサロゲートペア: UTF-16では2ユニットだが1文字。
    assert.equal(await atomsOf("<p>𠮟る</p>"), 2);
  });

  it("excludes ruby readings (rt/rp)", async () => {
    // 漢字(2) のみ。かんじ(3) と括弧は数えない。
    const body = "<p><ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby></p>";
    assert.equal(await atomsOf(body), 2);
  });

  it("counts a replaced element as exactly one atom", async () => {
    assert.equal(await atomsOf(`<p><img src="a.png"/></p>`), 1);
    assert.equal(await atomsOf(`<p>あ<img src="a.png"/>い</p>`), 3);
  });

  it("does not descend into a replaced element's subtree", async () => {
    // svg配下のtextは数えない。svg自体が1原子。
    assert.equal(await atomsOf(`<svg><text>無視される</text></svg>`), 1);
  });

  it("ignores whitespace-only text nodes between blocks", async () => {
    const indented = "\n  <p>あい</p>\n  <p>うえ</p>\n";
    assert.equal(await atomsOf(indented), 4);
  });

  it("keeps whitespace inside a text run", async () => {
    assert.equal(await atomsOf("<p>a b</p>"), 3);
  });

  it("does not count body-level script/style text", async () => {
    // script/style の中身は描画されないため原子に数えない。あい(2)のみ。
    assert.equal(await atomsOf("<p>あい</p><script>var x = 12345;</script>"), 2);
    assert.equal(await atomsOf("<p>あい</p><style>.c{color:red}</style>"), 2);
  });

  it("emits CDATA body text as ordinary text and counts it", async () => {
    // CDATAはブラウザで消えるが walkAtoms は数える。両者を一致させる。
    const book = await bookOf("<p>前<![CDATA[中]]>後</p>");
    assert.equal(book.totalAtoms, 3);
  });

  it("makes an image-only section addressable", async () => {
    // 固定レイアウト書籍の表紙。原子0だとブックマークできない。
    const book = await bookOf(`<div><img src="cover.jpg"/></div>`);
    assert.equal(book.totalAtoms, 1);
    assert.equal(book.sections[0].isImageOnly, true);
  });

  it("does not mark a section with prose as image-only", async () => {
    const book = await bookOf(`<p>文章</p><img src="a.png"/>`);
    assert.equal(book.sections[0].isImageOnly, false);
  });
});

describe("fragment ids", () => {
  it("records an id on <body> at offset 0", async () => {
    const book = await bookOf("<p>本文</p>", { bodyId: "start" });
    assert.equal(book.sections[0].ids.get("start"), 0);
  });

  it("records mid-document ids at their atom offset", async () => {
    const book = await bookOf(`<p>あいう</p><p id="second">えお</p>`);
    assert.equal(book.sections[0].ids.get("second"), 3);
  });

  it("records an id on a replaced element", async () => {
    const book = await bookOf(`<p>あい</p><img id="pic" src="a.png"/>`);
    assert.equal(book.sections[0].ids.get("pic"), 2);
  });
});

describe("section metadata", () => {
  it("detects vertical/horizontal from body and html classes", async () => {
    assert.equal((await bookOf("<p>あ</p>", { bodyClass: "vrtl" })).sections[0].direction, "vertical");
    assert.equal((await bookOf("<p>あ</p>", { htmlClass: "hltr" })).sections[0].direction, "horizontal");
    assert.equal((await bookOf("<p>あ</p>")).sections[0].direction, null);
  });

  it("keeps page progression separate from writing direction", async () => {
    assert.equal((await bookOf("<p>あ</p>")).pageProgressionDirection, "rtl"); // test fixture default
  });

  it("detects page spread from spine properties", async () => {
    const epub = await parseEpub(
      makeEpub({
        files: { "a.xhtml": xhtml("<p>あ</p>"), "b.xhtml": xhtml("<p>い</p>") },
        manifest: [
          { id: "a", href: "a.xhtml", mediaType: "application/xhtml+xml" },
          { id: "b", href: "b.xhtml", mediaType: "application/xhtml+xml" },
        ],
        spine: [
          { idref: "a", properties: "page-spread-right" },
          { idref: "b", properties: "page-spread-left" },
        ],
      }),
    );
    const book = await buildBook("t", epub);
    assert.equal(book.sections[0].forcedSide, "right");
    assert.equal(book.sections[1].forcedSide, "left");
  });

  // 2ページ(a/b)のBookを組む。各itemrefにspine propertiesを付与できる。
  async function twoSection(aProps: string, bProps: string, spec: { spread?: string; layout?: string } = {}) {
    const epub = await parseEpub(
      makeEpub({
        ...spec,
        files: { "a.xhtml": xhtml("<p>あ</p>"), "b.xhtml": xhtml("<p>い</p>") },
        manifest: [
          { id: "a", href: "a.xhtml", mediaType: "application/xhtml+xml" },
          { id: "b", href: "b.xhtml", mediaType: "application/xhtml+xml" },
        ],
        spine: [
          { idref: "a", properties: aProps },
          { idref: "b", properties: bProps },
        ],
      }),
    );
    return (await buildBook("t", epub)).sections;
  }

  it("resolves per-section layout from an itemref override, leaving neighbours alone", async () => {
    const s = await twoSection("rendition:layout-pre-paginated", "");
    assert.equal(s[0].layout, "pre-paginated");
    assert.equal(s[1].layout, "reflowable"); // 書籍既定 reflowable を継承
  });

  it("lets an itemref rendition:spread-none override the book default", async () => {
    const s = await twoSection("rendition:spread-none", "", { spread: "landscape" });
    assert.equal(s[0].spreadPolicy, "none");
    assert.equal(s[1].spreadPolicy, "landscape"); // 書籍既定を継承
  });

  it("inherits the book spread default when the itemref has no rendition:spread-*", async () => {
    const s = await twoSection("", "", { spread: "both" });
    assert.equal(s[0].spreadPolicy, "both");
    assert.equal(s[1].spreadPolicy, "both");
  });

  it("treats rendition:page-spread-center as a forced side, not a spread policy", async () => {
    const s = await twoSection("rendition:page-spread-center", "", { spread: "auto" });
    assert.equal(s[0].forcedSide, "center");
    assert.equal(s[0].spreadPolicy, "auto"); // 方針は書籍既定のまま
  });

  it("keeps spreadPolicy at the book default for page-spread-left/right", async () => {
    const s = await twoSection("page-spread-right", "page-spread-left", { spread: "landscape" });
    assert.equal(s[0].forcedSide, "right");
    assert.equal(s[1].forcedSide, "left");
    assert.equal(s[0].spreadPolicy, "landscape");
    assert.equal(s[1].spreadPolicy, "landscape");
  });

  it("skips non-linear spine items and keeps atom ranges contiguous", async () => {
    const epub = await parseEpub(
      makeEpub({
        files: {
          "a.xhtml": xhtml("<p>あい</p>"),
          "skip.xhtml": xhtml("<p>とばす</p>"),
          "b.xhtml": xhtml("<p>うえお</p>"),
        },
        manifest: [
          { id: "a", href: "a.xhtml", mediaType: "application/xhtml+xml" },
          { id: "skip", href: "skip.xhtml", mediaType: "application/xhtml+xml" },
          { id: "b", href: "b.xhtml", mediaType: "application/xhtml+xml" },
        ],
        spine: [{ idref: "a" }, { idref: "skip", linear: false }, { idref: "b" }],
      }),
    );
    const book = await buildBook("t", epub);
    assert.equal(book.sections.length, 2);
    assert.deepEqual(
      book.sections.map((s) => [s.startAtom, s.endAtom]),
      [
        [0, 2],
        [2, 5],
      ],
    );
    assert.equal(book.totalAtoms, 5);
  });

  it("uses flow indexes for sections and chapter targets when raw spine entries are skipped", async () => {
    const epub = await parseEpub(
      makeEpub({
        files: {
          "skip.xhtml": xhtml("<p>skip</p>"),
          "a.xhtml": xhtml("<p>A</p>"),
          "b.xhtml": xhtml("<p>B</p>"),
        },
        manifest: [
          { id: "skip", href: "skip.xhtml", mediaType: "application/xhtml+xml" },
          { id: "a", href: "a.xhtml", mediaType: "application/xhtml+xml" },
          { id: "b", href: "b.xhtml", mediaType: "application/xhtml+xml" },
        ],
        spine: [{ idref: "skip", linear: false }, { idref: "a" }, { idref: "b" }],
        nav: '<ol><li><a href="a.xhtml">A</a></li><li><a href="b.xhtml">B</a></li></ol>',
      }),
    );
    const book = await buildBook("t", epub);
    assert.deepEqual(
      book.sections.map((section) => [section.spineIndex, section.epubSpineIndex]),
      [
        [0, 1],
        [1, 2],
      ],
    );
    assert.deepEqual(
      book.chapters.map((chapter) => chapter.target?.spineIndex),
      [0, 1],
    );
  });
});

describe("section css links", () => {
  // head内のlink群とCSSファイルを持つ単一セクションのBookを組み立てる。
  async function sectionWith(head: string, cssFiles: string[]) {
    const files: Record<string, string> = { "c1.xhtml": xhtml("<p>本文</p>", { head }) };
    const manifest = [{ id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" }];
    for (const name of cssFiles) {
      files[name] = "p{}";
      manifest.push({ id: name, href: name, mediaType: "text/css" });
    }
    const epub = await parseEpub(makeEpub({ files, manifest, spine: [{ idref: "c1" }] }));
    return (await buildBook("t", epub)).sections[0];
  }

  it("includes only rel=stylesheet, excluding alternate stylesheets", async () => {
    const s = await sectionWith(
      `<link rel="stylesheet" href="a.css"/><link rel="alternate stylesheet" href="b.css"/>`,
      ["a.css", "b.css"],
    );
    assert.deepEqual(s.cssHrefs, ["OEBPS/a.css"]);
  });

  it("accepts uppercase rel and rejects 'stylesheet alternate'", async () => {
    const s = await sectionWith(
      `<link rel="STYLESHEET" href="a.css"/><link rel="stylesheet alternate" href="b.css"/>`,
      ["a.css", "b.css"],
    );
    assert.deepEqual(s.cssHrefs, ["OEBPS/a.css"]);
  });

  it("drops a link whose href escapes the root", async () => {
    const s = await sectionWith(`<link rel="stylesheet" href="../../x.css"/>`, []);
    assert.deepEqual(s.cssHrefs, []);
  });

  it("drops a link to a file not present in the archive", async () => {
    const s = await sectionWith(`<link rel="stylesheet" href="missing.css"/>`, []);
    assert.deepEqual(s.cssHrefs, []);
  });

  it("dedupes duplicate links preserving order", async () => {
    const s = await sectionWith(
      `<link rel="stylesheet" href="b.css"/><link rel="stylesheet" href="a.css"/><link rel="stylesheet" href="b.css"/>`,
      ["a.css", "b.css"],
    );
    assert.deepEqual(s.cssHrefs, ["OEBPS/b.css", "OEBPS/a.css"]);
  });

  it("captures htmlClass and bodyClass", async () => {
    const book = await bookOf("<p>本文</p>", { htmlClass: "hltr", bodyClass: "p-text" });
    assert.equal(book.sections[0].htmlClass, "hltr");
    assert.equal(book.sections[0].bodyClass, "p-text");
  });
});

describe("manifest fallback chains", () => {
  // spineが画像を直接参照し、manifestのfallbackがXHTMLを指す固定レイアウト書籍。
  const fixedLayout = () =>
    makeEpub({
      files: { "cover.jpg": "not really a jpeg", "cover.xhtml": xhtml(`<img src="cover.jpg"/>`) },
      manifest: [
        { id: "img", href: "cover.jpg", mediaType: "image/jpeg", fallback: "page" },
        { id: "page", href: "cover.xhtml", mediaType: "application/xhtml+xml" },
      ],
      spine: [{ idref: "img" }],
      nav: `<ol><li><a href="cover.jpg">表紙</a></li></ol>`,
    });

  it("follows the fallback to the content document", async () => {
    const book = await buildBook("t", await parseEpub(fixedLayout()));
    assert.equal(book.sections.length, 1);
    assert.equal(book.sections[0].href, "OEBPS/cover.xhtml");
    assert.equal(book.sections[0].isImageOnly, true);
  });

  it("resolves a TOC entry that addresses the spine href, not the fallback", async () => {
    const book = await buildBook("t", await parseEpub(fixedLayout()));
    assert.deepEqual(book.chapters[0].target, { spineIndex: 0, offset: 0 });
  });

  it("rejects a book whose fallback chains contain no content document", async () => {
    const epub = await parseEpub(
      makeEpub({
        files: { "cover.jpg": "bytes" },
        manifest: [{ id: "img", href: "cover.jpg", mediaType: "image/jpeg" }],
        spine: [{ idref: "img" }],
      }),
    );
    await assert.rejects(buildBook("t", epub), (error: unknown) => {
      return error instanceof Error && error.message === "The EPUB has no renderable linear spine documents.";
    });
  });
});

describe("chapters", () => {
  const withNav = async (nav: string, files?: Record<string, string>) => {
    const epub = await parseEpub(
      makeEpub({
        files: {
          "c1.xhtml": xhtml(`<p>あいう</p><p id="mid">えお</p>`),
          "c2.xhtml": xhtml("<p>かきく</p>"),
          ...files,
        },
        manifest: [
          { id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" },
          { id: "c2", href: "c2.xhtml", mediaType: "application/xhtml+xml" },
        ],
        spine: [{ idref: "c1" }, { idref: "c2" }],
        nav,
      }),
    );
    return buildBook("t", epub);
  };

  it("resolves an <a> nested inside a wrapper element", async () => {
    // <li><span><a href>: 一部の出版社はこの形で出力する。
    const book = await withNav(`<ol><li><span><a href="c1.xhtml">第一章</a></span></li></ol>`);
    assert.deepEqual(book.chapters[0].target, { spineIndex: 0, offset: 0 });
  });

  it("resolves a #fragment to its atom offset", async () => {
    const book = await withNav(`<ol><li><a href="c1.xhtml#mid">中程</a></li></ol>`);
    assert.deepEqual(book.chapters[0].target, { spineIndex: 0, offset: 3 });
  });

  it("falls back to offset 0 for an unresolvable fragment", async () => {
    const book = await withNav(`<ol><li><a href="c1.xhtml#nope">章</a></li></ol>`);
    assert.deepEqual(book.chapters[0].target, { spineIndex: 0, offset: 0 });
  });

  it("keeps a grouping heading and its navigable children", async () => {
    // href を持たない見出し。子を落としてはならない。
    const book = await withNav(
      `<ol><li><span>第一部</span><ol><li><a href="c2.xhtml">第二章</a></li></ol></li></ol>`,
    );
    assert.equal(book.chapters.length, 1);
    assert.equal(book.chapters[0].label, "第一部");
    assert.equal(book.chapters[0].target, undefined);
    assert.equal(book.chapters[0].children.length, 1);
    assert.deepEqual(book.chapters[0].children[0].target, { spineIndex: 1, offset: 0 });
  });

  it("does not let a parent <li> steal its child <ol>'s anchor", async () => {
    const book = await withNav(
      `<ol><li><ol><li><a href="c2.xhtml">子</a></li></ol></li></ol>`,
    );
    assert.equal(book.chapters[0].target, undefined);
    assert.deepEqual(book.chapters[0].children[0].target, { spineIndex: 1, offset: 0 });
  });

  it("preserves nesting depth", async () => {
    const book = await withNav(
      `<ol><li><a href="c1.xhtml">親</a><ol><li><a href="c1.xhtml#mid">子</a></li></ol></li></ol>`,
    );
    assert.equal(book.chapters[0].children[0].label, "子");
    assert.equal(book.chapters[0].children[0].target!.offset, 3);
  });
});
