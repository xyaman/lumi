// Framework-neutral reader store. A plain pub/sub state machine owning load →
// restore → navigate. `spineIndex` is the flow index into `book.sections`.

import { type Book, buildBook, parseEpub } from "@lostcoords/lumi-epub";
import { buildPosition } from "./positionBuilder";
import type { ReaderPorts } from "./ports";
import type { FlowMode, ReaderPosition } from "./types";

/** Top-level status of the load lifecycle. */
export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Restore sub-machine: a saved position is queued (`pending`), the renderer lands it (`applying` → `settling`), then back to `idle`. */
export type RestoreStatus = "idle" | "pending" | "applying" | "settling";

/** Paginated-renderer state. */
export type PaginatedState = {
  pageInChapter: number;
  totalPagesInChapter: number;
  /** Where to land after a chapter switch: `first` forward, `last` backward. */
  pendingPage: "first" | "last";
  /** Last href the paginated renderer drew. Lets it tell a fresh chapter render (use `pendingPage`) from a re-render of the same chapter (keep position). */
  lastRenderedHref: string | undefined;
  /** Fragment id → page-in-chapter, written by the renderer after layout. */
  fragmentPages: Map<string, number>;
};

export type ContinuousState = {
  scrollTop: number;
  scrollRange: number;
  viewportExtent: number;
  spineOffsets: number[];
  fragmentOffsets: Map<string, number>[];
};

/** Restore request state. `token` bumps whenever a new restore is queued; the renderer watches it. */
export type RestoreState = {
  status: RestoreStatus;
  token: number;
  point: ReaderPosition | null;
};

/** Full reader state. */
export type ReaderState = {
  status: LoadStatus;
  bookId: string | null;
  book: Book | null;
  error: string | null;
  flow: FlowMode;
  spineIndex: number;
  pendingFragment: string | null;
  /** Bumps on every navigation; the renderer watches it. */
  navigationSeq: number;
  readingPoint: ReaderPosition | null;
  restore: RestoreState;
  paginated: PaginatedState;
  continuous: ContinuousState;
};

/** Imperative store handle. */
export type ReaderStore = {
  getState(): ReaderState;
  subscribe(listener: (state: ReaderState) => void): () => void;

  loadBook(bookId: string): Promise<void>;
  setFlowMode(flow: FlowMode): void;

  nextPage(): void;
  prevPage(): void;
  nextChapter(): void;
  prevChapter(): void;
  jumpToPosition(position: ReaderPosition): void;
  jumpToNavEntry(spineIndex: number, fragment: string | null): void;
  jumpToHref(absPath: string, fragment: string | null): void;

  /** Renderer-facing: report measured geometry and drive the restore sub-machine. */
  setPaginatedMetrics(patch: Partial<PaginatedState>): void;
  setContinuousMetrics(patch: Partial<ContinuousState>): void;
  setRestoreStatus(status: RestoreStatus): void;
  /** Renderer settled on a live reading position (page or scroll committed): updates `readingPoint` and notifies the host — never `navigationSeq` — and is the only path by which position reaches the host, so renderers never call callbacks directly. */
  reportPosition(position: ReaderPosition): void;
  /** Renderer consumed a queued fragment target; clear it so a later plain re-render doesn't re-seek. */
  clearPendingFragment(): void;
  /** Continuous renderer reporting the section now in view. Updates the flow index WITHOUT bumping `navigationSeq` (that would re-trigger a scroll). */
  setVisibleSpineIndex(index: number): void;
};

/** Configuration for `createReaderStore`. */
export type ReaderStoreConfig = {
  ports: ReaderPorts;
  initialFlow?: FlowMode;
};

function emptyPaginated(): PaginatedState {
  return {
    pageInChapter: 0,
    totalPagesInChapter: 1,
    pendingPage: "first",
    lastRenderedHref: undefined,
    fragmentPages: new Map(),
  };
}

function emptyContinuous(): ContinuousState {
  return { scrollTop: 0, scrollRange: 1, viewportExtent: 0, spineOffsets: [], fragmentOffsets: [] };
}

/** Create the framework-neutral reader store. */
export function createReaderStore(config: ReaderStoreConfig): ReaderStore {
  const { ports } = config;
  const cb = (): ReaderPorts["callbacks"] => ports.callbacks;

  let state: ReaderState = {
    status: "idle",
    bookId: null,
    book: null,
    error: null,
    flow: config.initialFlow ?? "paginated",
    spineIndex: 0,
    pendingFragment: null,
    navigationSeq: 0,
    readingPoint: null,
    restore: { status: "idle", token: 0, point: null },
    paginated: emptyPaginated(),
    continuous: emptyContinuous(),
  };

  const listeners = new Set<(state: ReaderState) => void>();

  function emit(): void {
    for (const l of listeners) l(state);
  }
  // Replace top-level state with a new reference so framework adapters can diff cheaply.
  function set(patch: Partial<ReaderState>): void {
    state = { ...state, ...patch };
    emit();
  }
  function patchPaginated(patch: Partial<PaginatedState>): void {
    set({ paginated: { ...state.paginated, ...patch } });
  }

  function flowLength(): number {
    return state.book ? state.book.sections.length : 0;
  }

  // Clamp a flow index into the section range. A two-page spread counts as ONE step.
  function clampIndex(book: Book, i: number): number {
    return Math.max(Math.min(i, book.sections.length - 1), 0);
  }

  // Re-resolve a saved position by href (the spine can shift between sessions), then rebuild it against this book's atoms.
  function normalize(book: Book, position: ReaderPosition): ReaderPosition | null {
    const idx = resolveFlowIndex(book, position);
    if (idx === null) return null;
    return buildPosition(book, idx, position.locator.spineHref, position.locator.atomOffset) ?? position;
  }

  function resolveFlowIndex(book: Book, position: ReaderPosition): number | null {
    const { spineIndex, spineHref } = position.locator;
    if (book.sections[spineIndex]?.href === spineHref) return spineIndex;
    const byHref = book.sections.findIndex((s) => s.href === spineHref);
    return byHref >= 0 ? byHref : null;
  }

  function queueRestore(book: Book, point: ReaderPosition): void {
    set({
      spineIndex: clampIndex(book, point.locator.spineIndex),
      pendingFragment: null,
      readingPoint: point,
      restore: { status: "pending", token: state.restore.token + 1, point },
    });
    cb()?.onProgress?.(point.progress.fraction);
    cb()?.onPositionChange?.(point);
  }

  function queueContinuousTarget(spineIndex: number, fragment: string | null): void {
    set({ spineIndex, pendingFragment: fragment, navigationSeq: state.navigationSeq + 1 });
  }

  function setSpineIndex(i: number): void {
    if (!state.book) {
      set({ spineIndex: i });
      return;
    }
    set({ spineIndex: clampIndex(state.book, i) });
  }

  async function loadBook(bookId: string): Promise<void> {
    const previousBookId = state.status === "idle" ? null : state.bookId;
    if (previousBookId && previousBookId !== bookId) cb()?.onBookClosed?.(previousBookId);

    if (state.status === "ready" && state.bookId === bookId && state.book) {
      await resume(bookId, state.book);
      return;
    }
    if (state.status === "loading" && state.bookId === bookId) return;

    resetForLoad(bookId);

    try {
      const [blob, saved] = await Promise.all([
        ports.storage.loadBookFile(bookId),
        ports.storage.getPosition(bookId),
      ]);
      if (!blob) throw new Error(`Book file not found for id ${bookId}`);
      const epub = await parseEpub(blob);
      const book = await buildBook(bookId, epub);
      if (state.status !== "loading" || state.bookId !== bookId) return; // stale load

      const restorePoint = saved ? normalize(book, saved) : null;
      const clampedIndex = Math.max(Math.min(state.spineIndex, book.sections.length - 1), 0);
      set({ status: "ready", book, spineIndex: clampedIndex });
      if (restorePoint) queueRestore(book, restorePoint);
      cb()?.onBookOpened?.(bookId);
    } catch (e) {
      if (state.status !== "loading" || state.bookId !== bookId) return;
      set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function resume(bookId: string, book: Book): Promise<void> {
    if (state.readingPoint) {
      const p = normalize(book, state.readingPoint);
      if (p) queueRestore(book, p);
    }
    const saved = await ports.storage.getPosition(bookId);
    if (state.status !== "ready" || state.bookId !== bookId) return;
    if (saved) {
      const p = normalize(book, saved);
      if (p) queueRestore(book, p);
    }
  }

  function resetForLoad(bookId: string): void {
    set({
      status: "loading",
      bookId,
      book: null,
      error: null,
      spineIndex: 0,
      pendingFragment: null,
      navigationSeq: 0,
      readingPoint: null,
      restore: { status: "idle", token: state.restore.token + 1, point: null },
      paginated: emptyPaginated(),
      continuous: emptyContinuous(),
    });
  }

  function nextChapter(): void {
    if (!state.book) return;
    const next = state.spineIndex + 1;
    if (next < flowLength()) {
      set({
        spineIndex: next,
        navigationSeq: state.navigationSeq + 1,
        paginated: { ...state.paginated, pendingPage: "first" },
      });
    }
  }

  function prevChapter(): void {
    if (state.spineIndex > 0) {
      patchPaginated({ pendingPage: "first" });
      set({ navigationSeq: state.navigationSeq + 1 });
      setSpineIndex(state.spineIndex - 1);
    }
  }

  function nextPage(): void {
    if (state.paginated.pageInChapter < state.paginated.totalPagesInChapter - 1) {
      set({
        navigationSeq: state.navigationSeq + 1,
        paginated: { ...state.paginated, pageInChapter: state.paginated.pageInChapter + 1 },
      });
    } else {
      nextChapter();
    }
  }

  function prevPage(): void {
    if (state.paginated.pageInChapter > 0) {
      set({
        navigationSeq: state.navigationSeq + 1,
        paginated: { ...state.paginated, pageInChapter: state.paginated.pageInChapter - 1 },
      });
    } else if (state.spineIndex > 0) {
      set({ navigationSeq: state.navigationSeq + 1, paginated: { ...state.paginated, pendingPage: "last" } });
      setSpineIndex(state.spineIndex - 1);
    }
  }

  function jumpToPosition(position: ReaderPosition): void {
    if (state.status !== "ready" || !state.book) return;
    const restorePoint = normalize(state.book, position);
    if (restorePoint) queueRestore(state.book, restorePoint);
  }

  function jumpToNavEntry(spineIndex: number, fragment: string | null): void {
    if (state.status !== "ready" || !state.book) return;
    if (state.flow === "continuous") {
      queueContinuousTarget(spineIndex, fragment);
      return;
    }
    set({
      navigationSeq: state.navigationSeq + 1,
      spineIndex: clampIndex(state.book, spineIndex),
      pendingFragment: fragment,
      paginated: { ...state.paginated, pendingPage: "first" },
    });
  }

  function jumpToHref(absPath: string, fragment: string | null): void {
    if (state.status !== "ready" || !state.book) return;
    const idx = state.book.sections.findIndex((s) => s.href === absPath);
    if (idx < 0) return;

    if (state.flow === "continuous") {
      queueContinuousTarget(idx, fragment);
      return;
    }
    // Same-section tap: land directly on the fragment's page without a re-render.
    if (idx === state.spineIndex) {
      set({
        navigationSeq: state.navigationSeq + 1,
        paginated: {
          ...state.paginated,
          pageInChapter: fragment ? (state.paginated.fragmentPages.get(fragment) ?? 0) : 0,
        },
      });
      return;
    }
    jumpToNavEntry(idx, fragment);
  }

  return {
    getState: (): ReaderState => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadBook,
    setFlowMode(flow) {
      set({ flow });
    },
    nextPage,
    prevPage,
    nextChapter,
    prevChapter,
    jumpToPosition,
    jumpToNavEntry,
    jumpToHref,
    setPaginatedMetrics(patch) {
      patchPaginated(patch);
    },
    setContinuousMetrics(patch) {
      set({ continuous: { ...state.continuous, ...patch } });
    },
    setRestoreStatus(status) {
      set({ restore: { ...state.restore, status } });
    },
    reportPosition(position) {
      set({ readingPoint: position });
      cb()?.onProgress?.(position.progress.fraction);
      cb()?.onPositionChange?.(position);
    },
    clearPendingFragment() {
      if (state.pendingFragment !== null) set({ pendingFragment: null });
    },
    setVisibleSpineIndex(index) {
      if (index !== state.spineIndex) setSpineIndex(index);
    },
  };
}
