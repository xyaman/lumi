// Regression tests for planSpreads allocation rules.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type PageRef, planSpreads, type SectionSpreadMeta, type Slot } from "../src/index.js";

// Build section meta concisely.
const meta = (
  spineIndex: number,
  forcedSide: SectionSpreadMeta["forcedSide"] = null,
  spreadPolicy: SectionSpreadMeta["spreadPolicy"] = "auto",
  layout: SectionSpreadMeta["layout"] = "pre-paginated",
): SectionSpreadMeta => ({ spineIndex, forcedSide, spreadPolicy, layout });

// The single (first) page of a pre-paginated section.
const onePage = (spineIndex: number): PageRef => ({ spineIndex, localPage: 0, isSectionFirstPage: true });

// Which section a slot's page belongs to (blank / missing = -1). Tolerates
// undefined so tuple-union `slots[1]` access stays type-safe under strict tsc.
const slotSpine = (s: Slot | undefined): number => (s?.kind === "page" ? s.page.spineIndex : -1);
const slotKind = (s: Slot | undefined): string | undefined => s?.kind;

describe("planSpreads", () => {
  it("motivating case: rtl [right image][left toc] pairs into one spread, no blank", () => {
    const spreads = planSpreads([onePage(0), onePage(1)], [meta(0, "right"), meta(1, "left")], "rtl");
    assert.equal(spreads.length, 1);
    const [sp] = spreads;
    assert.equal(sp.slots.length, 2);
    assert.equal(slotSpine(sp.slots[0]), 0); // reading order slots[0]=right=image
    assert.equal(slotSpine(sp.slots[1]), 1); // slots[1]=left=toc
    assert.ok(sp.slots.every((s) => s.kind === "page"), "no blank inserted");
  });

  it("forced side with an unconstrained neighbour: [null caution][left toc] pairs", () => {
    const spreads = planSpreads([onePage(0), onePage(1)], [meta(0, null), meta(1, "left")], "rtl");
    assert.equal(spreads.length, 1);
    assert.equal(slotSpine(spreads[0].slots[0]), 0);
    assert.equal(slotSpine(spreads[0].slots[1]), 1);
    assert.ok(spreads[0].slots.every((s) => s.kind === "page"), "no blank inserted");
  });

  it("a run of same-side pages needs blanks in the left slot", () => {
    const spreads = planSpreads(
      [onePage(0), onePage(1), onePage(2)],
      [meta(0, "right"), meta(1, "right"), meta(2, "right")],
      "rtl",
    );
    assert.equal(spreads.length, 3);
    assert.deepEqual(
      spreads.map((s) => s.slots.map((x) => x.kind)),
      [["page", "blank"], ["page", "blank"], ["page", "blank"]],
    );
  });

  it("spreadPolicy none never pairs and does not pair its neighbours across it", () => {
    const spreads = planSpreads(
      [onePage(0), onePage(1), onePage(2)],
      [meta(0, null, "auto"), meta(1, null, "none"), meta(2, null, "auto")],
      "rtl",
    );
    assert.equal(spreads.length, 3);
    assert.deepEqual(spreads.map((s) => s.kind), ["pair", "single", "pair"]);
    assert.equal(slotSpine(spreads[1].slots[0]), 1);
    assert.equal(slotKind(spreads[0].slots[1]), "blank");
    assert.equal(slotKind(spreads[2].slots[1]), "blank");
  });

  it("forced center gets its own single spread and flushes the half-filled one", () => {
    const spreads = planSpreads([onePage(0), onePage(1)], [meta(0, null), meta(1, "center")], "rtl");
    assert.equal(spreads.length, 2);
    assert.equal(spreads[0].kind, "pair");
    assert.equal(slotSpine(spreads[0].slots[0]), 0);
    assert.equal(slotKind(spreads[0].slots[1]), "blank");
    assert.equal(spreads[1].kind, "single");
    assert.equal(slotSpine(spreads[1].slots[0]), 1);
  });

  it("reflowable: only localPage 0 is forced; later pages fill slots freely", () => {
    const sections = [meta(0, "left", "auto", "reflowable")];
    const pages: PageRef[] = [];
    for (let i = 0; i < 5; i++) pages.push({ spineIndex: 0, localPage: i, isSectionFirstPage: i === 0 });
    const spreads = planSpreads(pages, sections, "rtl");

    // localPage 0 is left-forced; rtl slot0=right, so a blank precedes it.
    assert.equal(slotKind(spreads[0].slots[0]), "blank");
    const p0 = spreads[0].slots[1];
    assert.equal(p0?.kind === "page" ? p0.page.localPage : -1, 0);

    const blanks = spreads.flatMap((s) => s.slots).filter((s) => s.kind === "blank").length;
    assert.equal(blanks, 1);
    const seen = spreads
      .flatMap((s) => s.slots)
      .filter((s) => s.kind === "page")
      .map((s) => (s.kind === "page" ? s.page.localPage : -1))
      .sort((a, b) => a - b);
    assert.deepEqual(seen, [0, 1, 2, 3, 4]);
  });

  it("ltr mirrors rtl: slot 0 is the left page", () => {
    const spreads = planSpreads([onePage(0), onePage(1)], [meta(0, "left"), meta(1, "right")], "ltr");
    assert.equal(spreads.length, 1);
    assert.equal(slotSpine(spreads[0].slots[0]), 0);
    assert.equal(slotSpine(spreads[0].slots[1]), 1);
    assert.ok(spreads[0].slots.every((s) => s.kind === "page"), "no blank");
  });

  it("property: every page appears exactly once, in spine order", () => {
    const forced: SectionSpreadMeta["forcedSide"][] = [null, "left", "right", "center", null];
    const pol: SectionSpreadMeta["spreadPolicy"][] = ["auto", "auto", "none", "auto", "auto"];
    const sections: SectionSpreadMeta[] = [];
    const pages: PageRef[] = [];
    for (let i = 0; i < 20; i++) {
      sections.push(meta(i, forced[i % forced.length], pol[i % pol.length]));
      pages.push(onePage(i));
    }
    const spreads = planSpreads(pages, sections, "rtl");
    const order = spreads.flatMap((s) => s.slots).filter((s) => s.kind === "page").map(slotSpine);
    assert.deepEqual(order, [...Array(20).keys()]);
    assert.ok(spreads.every((s) => s.slots.length <= 2));
  });

  it("a trailing lone page is a blank-padded pair, not a centered single", () => {
    const spreads = planSpreads(
      [onePage(0), onePage(1), onePage(2)],
      [meta(0, null), meta(1, null), meta(2, null)],
      "rtl",
    );
    assert.equal(spreads.length, 2);
    assert.equal(spreads[1].kind, "pair");
    assert.equal(slotKind(spreads[1].slots[0]), "page");
    assert.equal(slotKind(spreads[1].slots[1]), "blank");
  });
});
