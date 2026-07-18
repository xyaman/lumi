// Reader-core domain types. Positions and highlights ride @lostcoords/lumi-epub's atom
// coordinate (one atom per code point in non-whitespace-only text nodes, one per replaced element),
// so they are independent of font, viewport, and pagination. Persistence/sync
// fields are app concerns; the host app extends these shapes via the ports.

/** A durable location inside a book. */
export type ReaderLocator = {
  /** Flow index into `book.sections` (not the raw EPUB spine index). */
  spineIndex: number;
  /** ZIP-absolute href of the spine item. Redundant anchor for robustness. */
  spineHref: string;
  /** Section-local atom offset. */
  atomOffset: number;
};

/** Progress derived from a locator. `fraction` is book-global [0, 1]. */
export type ReadingProgress = {
  globalAtomOffset: number; // section.startAtom + locator.atomOffset
  totalAtoms: number; // book.totalAtoms
  /** `globalAtomOffset / max(totalAtoms, 1)`, clamped to [0, 1]. */
  fraction: number;
};

/** A restore target plus its derived progress. */
export type ReaderPosition = {
  version: 1;
  locator: ReaderLocator;
  progress: ReadingProgress;
};

/** Runtime validation for positions crossing storage or network boundaries. */
export function isReaderPosition(value: unknown): value is ReaderPosition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReaderPosition>;
  const locator = candidate.locator as Partial<ReaderLocator> | undefined;
  return (
    candidate.version === 1 &&
    !!locator &&
    Number.isInteger(locator.spineIndex) &&
    (locator.spineIndex as number) >= 0 &&
    typeof locator.spineHref === "string" &&
    Number.isFinite(locator.atomOffset) &&
    (locator.atomOffset as number) >= 0
  );
}

/** `highlight` is a painted span (start < end). `page` is a one-tap page mark (start === end) — also covers text-less pages like covers/illustrations; not painted. */
export type HighlightKind = "highlight" | "page";

/** Minimal highlight shape the engine needs to paint and hit-test. The app's full record (note, timestamps, sync state) is a superset. */
export type HighlightSpan = {
  id: string;
  kind: HighlightKind;
  start: ReaderLocator;
  end: ReaderLocator;
};

/** A Japanese tokenization chip (surface form + linguistic metadata). */
export type TokenChip = {
  /** Surface form as it appears in text. */
  s: string;
  /** Part of speech. */
  pos: string;
  /** Whether this chip is the primary reading of its surface form. */
  primary: boolean;
  /** Dictionary form. */
  lemma: string;
};

/** Writing direction resolved for a section or the whole book. */
export type ReadingDirection = "horizontal" | "vertical";

/** How the book is laid out on screen. */
export type FlowMode = "paginated" | "continuous";
