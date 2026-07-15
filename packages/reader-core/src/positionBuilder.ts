import type { Book } from "@lostcoords/lumi-epub";
import type { ReaderPosition } from "./types";

/**
 * Resolve a book-relative reading location.
 * `spineIndex` is the flow index into `book.sections`, not the raw EPUB spine index.
 * `atomOffset` is section-local and clamped into the section's atom range.
 * Returns null if `spineIndex` is out of range.
 */
export function buildPosition(
  book: Book,
  spineIndex: number,
  spineHref: string,
  atomOffset: number,
): ReaderPosition | null {
  const section = book.sections[spineIndex];
  if (!section) return null;

  const sectionAtoms = section.endAtom - section.startAtom;
  const clamped = Math.min(Math.max(Math.floor(atomOffset), 0), sectionAtoms);
  const globalAtomOffset = section.startAtom + clamped;
  const totalAtoms = Math.max(book.totalAtoms, 1);

  return {
    version: 1,
    locator: {
      spineIndex,
      spineHref: section.href || spineHref,
      atomOffset: clamped,
    },
    progress: {
      globalAtomOffset,
      totalAtoms: book.totalAtoms,
      fraction: Math.min(Math.max(globalAtomOffset / totalAtoms, 0), 1),
    },
  };
}
