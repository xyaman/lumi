// buildPosition: atom offset → ReaderPosition (locator + derived progress).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Book, Section } from "@lumi/epub";
import { buildPosition } from "../src/index.js";

// Minimal Book fixture. `spineIndex` addresses book.sections by position (flow
// index). Raw Section.spineIndex is intentionally non-contiguous (a non-linear
// epub item was skipped at parse) to prove we index by position, not by it.
function makeBook(): Book {
  const sections = [
    { spineIndex: 0, startAtom: 0, endAtom: 10, href: "a.xhtml" },
    { spineIndex: 2, startAtom: 10, endAtom: 25, href: "b.xhtml" },
    { spineIndex: 3, startAtom: 25, endAtom: 30, href: "" }, // empty href → falls back to arg
  ] as Section[];
  return { sections, totalAtoms: 30 } as unknown as Book;
}

describe("buildPosition", () => {
  it("resolves a section-local atom offset to a global position", () => {
    const pos = buildPosition(makeBook(), 1, "b.xhtml", 5); // flow index 1 = second section
    assert.deepEqual(pos, {
      version: 1,
      locator: { spineIndex: 1, spineHref: "b.xhtml", atomOffset: 5 },
      progress: { globalAtomOffset: 15, totalAtoms: 30, fraction: 15 / 30 },
    });
  });

  it("uses section.startAtom as the global baseline (no prefix sum)", () => {
    assert.equal(buildPosition(makeBook(), 0, "a.xhtml", 3)?.progress.globalAtomOffset, 3);
    assert.equal(buildPosition(makeBook(), 2, "c.xhtml", 2)?.progress.globalAtomOffset, 27);
  });

  it("clamps the offset into the section's atom range", () => {
    assert.equal(buildPosition(makeBook(), 0, "a.xhtml", 999)?.locator.atomOffset, 10);
    assert.equal(buildPosition(makeBook(), 0, "a.xhtml", -5)?.locator.atomOffset, 0);
  });

  it("floors a fractional offset", () => {
    assert.equal(buildPosition(makeBook(), 0, "a.xhtml", 3.7)?.locator.atomOffset, 3);
  });

  it("falls back to the passed href when the section href is empty", () => {
    assert.equal(buildPosition(makeBook(), 2, "fallback.xhtml", 1)?.locator.spineHref, "fallback.xhtml");
  });

  it("returns null for an out-of-range flow index", () => {
    assert.equal(buildPosition(makeBook(), 3, "x.xhtml", 0), null);
    assert.equal(buildPosition(makeBook(), -1, "x.xhtml", 0), null);
  });

  it("clamps fraction to [0,1] at the book end", () => {
    assert.equal(buildPosition(makeBook(), 2, "c.xhtml", 5)?.progress.fraction, 1);
  });
});
