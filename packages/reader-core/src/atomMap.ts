// Client-side atom ⇄ DOM mapping. Re-walks the rendered DOM by the same rules as
// @lostcoords/lumi-epub's `walkAtoms` so live DOM points resolve to identical atom offsets.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

/** Replaced elements: one atom, subtree not walked. */
const REPLACED = new Set(["img", "svg", "image", "video", "audio"]);

/** Skipped elements: ruby readings and non-rendered content. */
const SKIPPED = new Set(["rt", "rp", "script", "style"]);

/** A text node segment (1 atom per code point) or a replaced element (1 atom). */
export type AtomUnit =
  | { kind: "text"; node: Text; atomStart: number; atomEnd: number }
  | { kind: "replaced"; node: Element; atomStart: number; atomEnd: number };

/** A resolved DOM point (container node + offset), as consumed by Range APIs. */
export type DomPoint = { node: Node; offset: number };

function localName(el: Element): string {
  return (el.localName ?? el.nodeName).toLowerCase();
}

function isWhitespaceOnly(text: string): boolean {
  return !/\S/.test(text);
}

/** UTF-16 offset within a text node → code points before that offset. */
function codePointsBefore(text: string, utf16Offset: number): number {
  return [...text.slice(0, utf16Offset)].length;
}

/** Nth code point within a text node → UTF-16 offset (what Range APIs expect). */
function utf16OffsetForCodePoint(text: string, codePoints: number): number {
  const arr = [...text];
  const clamped = Math.max(0, Math.min(codePoints, arr.length));
  return arr.slice(0, clamped).join("").length;
}

function indexInParent(node: Node): number {
  const parent = node.parentNode;
  if (!parent) return 0;
  let i = 0;
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c === node) return i;
    i++;
  }
  return 0;
}

/** Walk a mounted content container with the same rules as `walkAtoms`, producing units keyed to live DOM nodes. */
export function collectAtomUnits(container: Node): AtomUnit[] {
  const units: AtomUnit[] = [];
  let atom = 0;

  const visit = (node: Node): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      const type = child.nodeType;

      if (type === TEXT_NODE || type === CDATA_NODE) {
        const text = child.nodeValue ?? "";
        if (isWhitespaceOnly(text)) continue;
        const length = [...text].length;
        units.push({ kind: "text", node: child as Text, atomStart: atom, atomEnd: atom + length });
        atom += length;
        continue;
      }
      if (type !== ELEMENT_NODE) continue;

      const el = child as Element;
      const tag = localName(el);
      if (SKIPPED.has(tag)) continue;

      if (REPLACED.has(tag)) {
        units.push({ kind: "replaced", node: el, atomStart: atom, atomEnd: atom + 1 });
        atom += 1;
        continue;
      }
      visit(el);
    }
  };

  visit(container);
  return units;
}

/** Total atoms in a mounted container. Must equal `section.endAtom - section.startAtom`. */
export function countAtoms(container: Node): number {
  const units = collectAtomUnits(container);
  return units.length ? units[units.length - 1].atomEnd : 0;
}

/** Resolve a selection endpoint to its section-local atom offset. Pass precomputed `units` to skip re-walking both endpoints. */
export function pointToAtom(
  container: Node,
  node: Node,
  offset: number,
  which: "start" | "end",
  units: AtomUnit[] = collectAtomUnits(container),
): number | null {
  if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) {
    const unit = units.find((u) => u.node === node);
    if (unit && unit.kind === "text") {
      return unit.atomStart + codePointsBefore(node.nodeValue ?? "", offset);
    }
    // Whitespace-only text node (no entry in `units`): fall through to element-level logic.
  }

  // Element-level (or non-unit) endpoint: collapse to the enclosed atoms.
  const enclosed = units.filter((u) => nodeContains(node, u.node));
  if (enclosed.length === 0) return null;
  return which === "start" ? enclosed[0].atomStart : enclosed[enclosed.length - 1].atomEnd;
}

/** Section-local atom offset → a live DOM point usable with Range APIs. */
export function atomToPoint(
  container: Node,
  atom: number,
  units: AtomUnit[] = collectAtomUnits(container),
): DomPoint | null {
  for (const unit of units) {
    if (atom < unit.atomStart || atom > unit.atomEnd) continue;

    if (unit.kind === "text") {
      const text = unit.node.nodeValue ?? "";
      return { node: unit.node, offset: utf16OffsetForCodePoint(text, atom - unit.atomStart) };
    }
    // Replaced element: a boundary in its parent, before or after the element.
    const parent = unit.node.parentNode;
    if (!parent) return null;
    const index = indexInParent(unit.node);
    return { node: parent, offset: atom === unit.atomStart ? index : index + 1 };
  }
  return null;
}

/** `[startAtom, endAtom]` span within one mounted section → a live `Range`, or `null` when the span is collapsed (e.g. page marks — never painted). */
export function atomToRange(container: Node, startAtom: number, endAtom: number): Range | null {
  const units = collectAtomUnits(container);
  const start = atomToPoint(container, startAtom, units);
  const end = atomToPoint(container, endAtom, units);
  if (!start || !end) return null;

  const ownerDoc = container.ownerDocument ?? (container as Document);
  const range = ownerDoc.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

/** True if `ancestor` contains `node` (or is `node`). Uses native `Node.contains` when present, with a manual walk as a fallback. */
function nodeContains(ancestor: Node, node: Node): boolean {
  if (typeof ancestor.contains === "function") return ancestor.contains(node);
  for (let n: Node | null = node; n; n = n.parentNode) {
    if (n === ancestor) return true;
  }
  return false;
}
