// Verifies the client atom walk matches @lumi/epub's walkAtoms, plus atom ⇄ DOM
// round-trips. The atom-count cases deliberately mirror the expected values in
// @lumi/epub/test/section-builder.test.ts — if the walk rules diverge in either
// package, the mirrored numbers here catch it.

import "./helpers/dom.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atomToPoint, atomToRange, countAtoms, pointToAtom } from "../src/index.js";

// Build a rendered content container (mirrors the mounted `.lumi-content` root).
function container(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

const atomsOf = (html: string) => countAtoms(container(html));

describe("atom counting (parity with @lumi/epub walkAtoms)", () => {
  it("counts base text by code point", () => {
    assert.equal(atomsOf("<p>あいうえお</p>"), 5);
  });

  it("counts astral code points as one atom each", () => {
    assert.equal(atomsOf("<p>𠮟る</p>"), 2);
  });

  it("excludes ruby readings (rt/rp)", () => {
    assert.equal(atomsOf("<p><ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby></p>"), 2);
  });

  it("counts a replaced element as exactly one atom", () => {
    assert.equal(atomsOf(`<p><img src="a.png"></p>`), 1);
    assert.equal(atomsOf(`<p>あ<img src="a.png">い</p>`), 3);
  });

  it("does not descend into a replaced element's subtree", () => {
    assert.equal(atomsOf(`<svg><text>ignored</text></svg>`), 1);
  });

  it("ignores whitespace-only text nodes between blocks", () => {
    assert.equal(atomsOf("\n  <p>あい</p>\n  <p>うえ</p>\n"), 4);
  });

  it("keeps whitespace inside a text run", () => {
    assert.equal(atomsOf("<p>a b</p>"), 3);
  });

  it("does not count script/style text", () => {
    assert.equal(atomsOf("<p>あい</p><script>var x = 12345;</script>"), 2);
    assert.equal(atomsOf("<p>あい</p><style>.c{color:red}</style>"), 2);
  });
});

describe("pointToAtom", () => {
  it("maps a text-node offset to its atom (BMP)", () => {
    const root = container("<p>あいうえお</p>");
    const text = root.querySelector("p")!.firstChild as Text;
    assert.equal(pointToAtom(root, text, 0, "start"), 0);
    assert.equal(pointToAtom(root, text, 3, "start"), 3);
    assert.equal(pointToAtom(root, text, 5, "end"), 5);
  });

  it("counts by code point, not UTF-16 unit", () => {
    const root = container("<p>𠮟る</p>"); // 𠮟 is a surrogate pair
    const text = root.querySelector("p")!.firstChild as Text;
    // UTF-16 offset 2 is just past the surrogate pair = 1 code point.
    assert.equal(pointToAtom(root, text, 2, "start"), 1);
  });

  it("collapses an element-level endpoint to its enclosed atom range", () => {
    const root = container("<p>あ<img src='a.png'>い</p>");
    const p = root.querySelector("p")!;
    assert.equal(pointToAtom(root, p, 0, "start"), 0);
    assert.equal(pointToAtom(root, p, 0, "end"), 3);
  });
});

describe("atomToPoint / atomToRange", () => {
  it("resolves an atom back to a DOM point (round-trip)", () => {
    const root = container("<p>あいうえお</p>");
    const text = root.querySelector("p")!.firstChild as Text;
    const point = atomToPoint(root, 3);
    assert.deepEqual(point, { node: text, offset: 3 });
  });

  it("resolves an astral atom to the correct UTF-16 offset", () => {
    const root = container("<p>𠮟る</p>");
    const point = atomToPoint(root, 1);
    assert.equal(point?.offset, 2); // past the surrogate pair
  });

  it("builds a Range over a text span", () => {
    const root = container("<p>あ<img src='a.png'>い</p>");
    assert.equal(atomToRange(root, 0, 1)?.toString(), "あ");
    assert.equal(atomToRange(root, 2, 3)?.toString(), "い");
    // Atoms 0..3 span the whole paragraph; the img contributes no text.
    assert.equal(atomToRange(root, 0, 3)?.toString(), "あい");
  });

  it("returns null for a collapsed span (page mark)", () => {
    const root = container("<p>あいう</p>");
    assert.equal(atomToRange(root, 1, 1), null);
  });

  it("round-trips every text atom boundary", () => {
    const root = container("<p>Hello 世界</p>");
    const total = countAtoms(root); // "Hello 世界" = 8 code points
    assert.equal(total, 8);
    for (let atom = 0; atom <= total; atom++) {
      const point = atomToPoint(root, atom);
      assert.ok(point, `atom ${atom} should resolve`);
      const back = pointToAtom(root, point.node, point.offset, "start");
      assert.equal(back, atom, `atom ${atom} round-trip`);
    }
  });
});
