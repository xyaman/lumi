// Two-page spread allocation. Pairing is stateful across the whole sequence
// (a lone page shifts parity), so feed the full page list — never compute
// spread boundaries locally.

import type { Section } from "@lumi/epub";

/** One page. `localPage` is the 0-based page number within its section. */
export type PageRef = {
  spineIndex: number;
  localPage: number;
  isSectionFirstPage: boolean;
};

/** One side of a spread. `blank` is a synthesized empty side (no content). */
export type Slot = { kind: "page"; page: PageRef } | { kind: "blank" };

/** `single` = shown alone or centered. `pair` = always two slots. */
export type Spread = { kind: "single"; slots: [Slot] } | { kind: "pair"; slots: [Slot, Slot] };

/** Subset of `Section` that `planSpreads` consumes. */
export type SectionSpreadMeta = {
  spineIndex: number;
  forcedSide: "left" | "right" | "center" | null;
  spreadPolicy: "auto" | "none" | "landscape" | "portrait" | "both";
  layout: "reflowable" | "pre-paginated";
};

/** Project an `@lumi/epub` `Section` to the metadata `planSpreads` consumes. */
export function toSpreadMeta(section: Section): SectionSpreadMeta {
  return {
    spineIndex: section.spineIndex,
    forcedSide: section.forcedSide,
    spreadPolicy: section.spreadPolicy,
    layout: section.layout,
  };
}

/** Slot index + progression direction → physical side. With `rtl`, slot 0 is the right side. */
export function slotSide(slotIndex: number, dir: "ltr" | "rtl"): "left" | "right" {
  if (dir === "rtl") return slotIndex === 0 ? "right" : "left";
  return slotIndex === 0 ? "left" : "right";
}

/** Allocate a page sequence into spreads; with rtl, slot 0 is physically the right side (clients map slot → physical side via `slotSide`). */
export function planSpreads(
  pages: PageRef[],
  sections: SectionSpreadMeta[],
  pageProgressionDirection: "ltr" | "rtl",
): Spread[] {
  const metaByIndex = new Map<number, SectionSpreadMeta>();
  for (const s of sections) metaByIndex.set(s.spineIndex, s);

  const spreads: Spread[] = [];
  let current: Slot[] = []; // partially filled spread (0 or 1 slot)

  // Pad a one-sided spread with a blank so it isn't confused with `single`.
  const flush = (): void => {
    if (current.length === 0) return;
    if (current.length === 1) current.push({ kind: "blank" });
    spreads.push({ kind: "pair", slots: [current[0], current[1]] });
    current = [];
  };

  for (const page of pages) {
    const meta = metaByIndex.get(page.spineIndex);
    // Reflowable constraints apply only to a section's first page; later pages are auto / null.
    const constrained = meta && (meta.layout === "pre-paginated" || page.isSectionFirstPage);
    const forcedSide = constrained ? (meta.forcedSide ?? null) : null;
    const policy = constrained ? meta.spreadPolicy : "auto";

    // 1) `none` or `center` → single spread (one centered page).
    if (policy === "none" || forcedSide === "center") {
      flush();
      spreads.push({ kind: "single", slots: [{ kind: "page", page }] });
      continue;
    }

    // 2) If a forced side disagrees with the free slot's side, insert a blank first.
    if (forcedSide === "left" || forcedSide === "right") {
      const freeSide = slotSide(current.length, pageProgressionDirection);
      if (freeSide !== forcedSide) {
        current.push({ kind: "blank" });
        if (current.length === 2) flush();
      }
    }

    // 3) Place the page in the free slot.
    current.push({ kind: "page", page });
    if (current.length === 2) flush();
  }

  flush();
  return spreads;
}
