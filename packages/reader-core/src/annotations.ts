// Paints host-provided annotations (see `HighlightSpan`) into a mounted render.
// Two paths, both anchored by the atom coordinate model:
//   • kind "highlight" → a CSS Custom Highlight (text-range), painted natively by
//     the browser so it follows scroll / paging / relayout with no repositioning.
//   • kind "page"      → a collapsed mark (a bookmark), drawn as a small icon in
//     an absolutely-positioned overlay over the non-scrolling mount host; the
//     renderer repositions it on page turn / scroll and hides it off-page.
// Framework-neutral: no app imports, no DOM assumptions beyond the render tree.

import { type AtomUnit, atomToRange, collectAtomUnits, pointToAtom } from "./atomMap";
import type { HighlightSpan } from "./types";

const HIGHLIGHT_NAME = "lumi-highlight";
const painterRanges = new Map<AnnotationPainter, Range[]>();
const LAYER_CSS = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:5";
// 20px filled bookmark (matches the ttu reader's `BookmarkSimple` at `size-5`).
const MARK_SIZE = 20;
// The icon sits in the inline-start margin, its right edge just left of the text.
const MARK_GUTTER = 20;
// opacity 0.25 matches the ttu reader's marker (a subtle bookmark, not a solid one).
const MARK_CSS = `position:absolute;display:block;width:${MARK_SIZE}px;height:${MARK_SIZE}px;opacity:0.25;pointer-events:none;color:var(--reader-ink,#5b6cb0)`;
// Phosphor `BookmarkSimple` (fill), the exact icon the ttu reader renders.
const MARK_SVG =
  `<svg viewBox="0 0 256 256" width="${MARK_SIZE}" height="${MARK_SIZE}" fill="currentColor" aria-hidden="true">` +
  '<path d="M184,32H72A16,16,0,0,0,56,48V224a8,8,0,0,0,12.24,6.78L128,193.43l59.77,37.35A8,8,0,0,0,200,224V48A16,16,0,0,0,184,32Z"/></svg>';

/** A mounted section the painter can anchor into. `atomCount` is `section.endAtom - section.startAtom`. */
export type PaintSection = {
  spineIndex: number;
  content: HTMLElement;
  atomCount: number;
  /** Stable atom walk for the current mounted DOM. */
  atomUnits?: AtomUnit[];
};

/** How a page-mark icon is positioned once its page is on screen. */
export type MarkPlacement = "line" | "page";

/** Viewport-relative position for a painted mark. */
type MarkPos = {
  left: number;
  top: number;
};

/** The subset of the Custom Highlight registry we use. */
type HighlightRegistry = {
  set(name: string, highlight: object): void;
  delete(name: string): void;
};

function highlightRegistry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const ctor = (globalThis as { Highlight?: unknown }).Highlight;
  return css?.highlights && typeof ctor === "function" ? css.highlights : null;
}

function makeHighlight(ranges: Range[]): object | null {
  const ctor = (globalThis as { Highlight?: new (...ranges: Range[]) => object }).Highlight;
  return ctor ? new ctor(...ranges) : null;
}

function updateHighlightRegistry(): void {
  const registry = highlightRegistry();
  if (!registry) return;
  const ranges = [...painterRanges.values()].flat();
  if (ranges.length === 0) {
    registry.delete(HIGHLIGHT_NAME);
    return;
  }
  const highlight = makeHighlight(ranges);
  if (highlight) registry.set(HIGHLIGHT_NAME, highlight);
}

/** Paints one render's annotations; owns the page-mark overlay and the Custom Highlight registration. */
export class AnnotationPainter {
  private layer: HTMLElement | undefined;

  constructor(private readonly doc: Document) {}

  /** (Re)register the text-range highlights across all mounted sections. Cheap; call whenever the DOM or the highlight set changes. */
  paintHighlights(sections: PaintSection[], highlights: HighlightSpan[]): void {
    const registry = highlightRegistry();
    if (!registry) return;

    const ranges: Range[] = [];
    for (const span of highlights) {
      if (span.kind !== "highlight") continue;
      for (const section of sections) {
        const range = rangeForSpan(section, span);
        if (range) ranges.push(range);
      }
    }
    painterRanges.set(this, ranges);
    updateHighlightRegistry();
  }

  /**
   * Position page-mark icons. `overlayParent` is where the overlay element lives
   * (the shadow root when the host carries one, else a light-DOM box); `reference`
   * is the non-scrolling positioned box marks are laid out against (their shared
   * containing block). A mark shows only when its atom is on the visible page.
   *
   * `placement` picks how the icon is positioned once its page is shown:
   *   • `"line"` — at the bookmarked atom's own line (continuous: rides the text).
   *   • `"page"` — at the reading area's inline-start corner (paginated: the whole
   *     page is bookmarked, so the marker is page-relative, not glyph-relative —
   *     robust to reflow/columns where the atom drifts mid-page).
   */
  paintMarks(
    overlayParent: Node,
    reference: HTMLElement,
    sections: PaintSection[],
    highlights: HighlightSpan[],
    placement: MarkPlacement = "line",
  ): void {
    const marks = highlights.filter((span) => span.kind === "page");
    if (marks.length === 0) {
      this.layer?.replaceChildren();
      return;
    }

    const layer = this.ensureLayer(overlayParent);
    const hostRect = reference.getBoundingClientRect();
    const children: HTMLElement[] = [];
    for (const mark of marks) {
      const section = sections.find((candidate) => candidate.spineIndex === mark.start.spineIndex);
      if (!section) continue;
      // The atom rect decides visibility (is the mark's page on screen?); placement
      // decides where the icon sits on that page.
      const rect = markRect(section, mark.start.atomOffset);
      if (!rect || !intersects(rect, hostRect)) continue;
      const pos = placement === "page" ? pageCornerPos(section.content) : { left: rect.left - MARK_GUTTER, top: rect.top };
      const el = this.doc.createElement("div");
      el.style.cssText = MARK_CSS;
      el.innerHTML = MARK_SVG;
      el.style.left = `${Math.max(pos.left - hostRect.left, 0)}px`;
      el.style.top = `${pos.top - hostRect.top}px`;
      children.push(el);
    }
    layer.replaceChildren(...children);
  }

  /** Release the Custom Highlight registration and remove the overlay. */
  destroy(): void {
    painterRanges.delete(this);
    updateHighlightRegistry();
    this.layer?.remove();
    this.layer = undefined;
  }

  private ensureLayer(overlayParent: Node): HTMLElement {
    let layer = this.layer;
    if (!layer) {
      layer = this.doc.createElement("div");
      layer.setAttribute("aria-hidden", "true");
      layer.style.cssText = LAYER_CSS;
      this.layer = layer;
    }
    // The parent may have been swapped out by a re-render (`shadow.replaceChildren`);
    // re-append so the overlay survives.
    if (layer.parentNode !== overlayParent) overlayParent.appendChild(layer);
    return layer;
  }
}

/** Section-local range for the part of `span` that falls inside `section` (clipped to its atom range). */
function rangeForSpan(section: PaintSection, span: HighlightSpan): Range | null {
  if (span.start.spineIndex > section.spineIndex || span.end.spineIndex < section.spineIndex) return null;
  const startAtom = span.start.spineIndex < section.spineIndex ? 0 : span.start.atomOffset;
  const endAtom = span.end.spineIndex > section.spineIndex ? section.atomCount : span.end.atomOffset;
  if (endAtom <= startAtom) return null;
  return atomToRange(section.content, startAtom, endAtom, section.atomUnits);
}

/** On-screen rect of the atom a collapsed mark points at (spans one atom for a stable rect). */
function markRect(section: PaintSection, atomOffset: number): DOMRect | null {
  const atom = Math.max(0, Math.min(atomOffset, Math.max(section.atomCount - 1, 0)));
  const range = atomToRange(section.content, atom, atom + 1, section.atomUnits);
  if (!range) return null;
  return firstUsableRect(range);
}

function firstUsableRect(range: Range): DOMRect | null {
  for (const rect of range.getClientRects()) {
    if (rect.width > 0 || rect.height > 0) return rect;
  }
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

function intersects(rect: DOMRect, host: DOMRect): boolean {
  return rect.right > host.left && rect.left < host.right && rect.bottom > host.top && rect.top < host.bottom;
}

/**
 * The reading area's inline-start top corner (viewport coords), already offset by
 * the gutter so a `MARK_SIZE` icon lands in the margin next to it. Page-relative,
 * so the marker stays put regardless of where the bookmarked atom drifts (reflow /
 * multi-column). `content`'s padding is the reader margin; its box doesn't move
 * with paged scroll, so the corner is the same on every page.
 */
function pageCornerPos(content: HTMLElement): MarkPos {
  const cs = getComputedStyle(content);
  const rect = content.getBoundingClientRect();
  const padTop = parseFloat(cs.paddingTop) || 0;
  if (cs.writingMode.startsWith("vertical")) {
    // vertical-rl reads from the right: mark the top-right margin.
    const padRight = parseFloat(cs.paddingRight) || 0;
    return { left: rect.right - padRight + MARK_GUTTER, top: rect.top + padTop };
  }
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  return { left: rect.left + padLeft - MARK_GUTTER, top: rect.top + padTop };
}

/** True when `span` covers section-local `atom` in section `spineIndex` (hit-testing highlights). */
export function spanCoversAtom(span: HighlightSpan, spineIndex: number, atom: number): boolean {
  if (span.kind !== "highlight") return false;
  const afterStart =
    spineIndex > span.start.spineIndex || (spineIndex === span.start.spineIndex && atom >= span.start.atomOffset);
  const beforeEnd =
    spineIndex < span.end.spineIndex || (spineIndex === span.end.spineIndex && atom < span.end.atomOffset);
  return afterStart && beforeEnd;
}

/** Section-local atom under a viewport point, or `null`. Best-effort: uses the platform caret-from-point API. */
export function atomAtClientPoint(
  doc: Document,
  content: HTMLElement,
  clientX: number,
  clientY: number,
  units: AtomUnit[] = collectAtomUnits(content),
): number | null {
  const caret = caretPoint(doc, clientX, clientY);
  if (!caret || !content.contains(caret.node)) return null;
  return pointToAtom(content, caret.node, caret.offset, "start", units);
}

type CaretPoint = { node: Node; offset: number };

function caretPoint(doc: Document, x: number, y: number): CaretPoint | null {
  const legacy = doc as Document & {
    caretRangeFromPoint?(x: number, y: number): Range | null;
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
  };
  if (typeof legacy.caretRangeFromPoint === "function") {
    const range = legacy.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  if (typeof legacy.caretPositionFromPoint === "function") {
    const pos = legacy.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  return null;
}
