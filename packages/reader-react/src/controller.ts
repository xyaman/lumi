// Framework-agnostic reader orchestration. The React wrapper (and the Svelte
// wrapper) drive it: it owns renderer lifecycle and the store-delta →
// renderer-method routing the app's views used to encode inline in effects.
//
// Store emits fire once per `set()`, so a single `loadBook` may emit "ready+book"
// and then "restore pending" separately. Emits are coalesced into one
// microtask-batched reconcile against the latest state — collapsing render
// scheduling the way Svelte effects collapse theirs — so we render once, not once
// per intermediate set.

import type { Book, Section } from "@lostcoords/lumi-epub";
import {
  ContinuousRenderer,
  PaginatedRenderer,
  type ReaderExtension,
  type ReaderSettings,
  type ReaderState,
  type ReaderStore,
  type SettingsPort,
} from "@lostcoords/lumi-reader-core";

/** Renderer surface the controller drives (both concrete renderers satisfy it; tests inject a fake). `applyPage` is paginated-only; `scheduleLayoutRefresh`/`scrollToCurrentTarget` are continuous-only; `applyPendingRestore` is shared — all flow-specific methods are optional and only called on the matching flow. */
export interface ReaderRenderer {
  mount(host: HTMLElement): void;
  destroy(): void;
  render(opts?: { preservePosition?: boolean }): Promise<void>;
  applyPage?(): void;
  applyPendingRestore?(): Promise<void | boolean>;
  applyTextColor?(): void;
  applyHighlights?(): void;
  scheduleLayoutRefresh?(): void;
  scrollToCurrentTarget?(): void;
}

/** Inputs a renderer is constructed with. The default factory forwards the paginated-only `spreadPartnerFor` to the paginated renderer and drops it for continuous. */
export type RendererDeps = {
  store: ReaderStore;
  settings: SettingsPort;
  extensions?: ReaderExtension[];
  spreadPartnerFor?(section: Section, book: Book): Section | null;
  doc: Document;
};

/** Builds the renderer for a flow. Injectable so tests (and alternate renderers) can replace the concrete classes. */
export type CreateRenderer = (flow: ReaderState["flow"], deps: RendererDeps) => ReaderRenderer;

const defaultCreateRenderer: CreateRenderer = (flow, deps) =>
  flow === "paginated"
    ? new PaginatedRenderer(deps)
    : new ContinuousRenderer({
        store: deps.store,
        settings: deps.settings,
        extensions: deps.extensions,
        doc: deps.doc,
      });

/** Configuration for `ReaderController`. */
export type ReaderControllerOptions = {
  store: ReaderStore;
  settings: SettingsPort;
  extensions?: ReaderExtension[];
  /** Optional pre-paginated spread partner (paginated only); see `PaginatedRenderer`. */
  spreadPartnerFor?(section: Section, book: Book): Section | null;
  /** Owning document (defaults to the ambient global). Injectable for testing. */
  doc?: Document;
  /** Renderer factory (defaults to the concrete renderers). Injectable for testing. */
  createRenderer?: CreateRenderer;
};

/** Store fields that drive a render decision. `spineIndex` is included but also changes passively in
 * continuous flow (`setVisibleSpineIndex` on scroll), so continuous navigation keys off `navigationSeq`,
 * never `spineIndex`. */
type Watched = {
  status: ReaderState["status"];
  book: Book | null;
  flow: ReaderState["flow"];
  spineIndex: number;
  navigationSeq: number;
  restoreToken: number;
  restoreStatus: ReaderState["restore"]["status"];
  highlights: ReaderState["highlights"];
};

function watch(s: ReaderState): Watched {
  return {
    status: s.status,
    book: s.book,
    flow: s.flow,
    spineIndex: s.spineIndex,
    navigationSeq: s.navigationSeq,
    restoreToken: s.restore.token,
    restoreStatus: s.restore.status,
    highlights: s.highlights,
  };
}

/** Imperative controller used by framework wrappers. */
export class ReaderController {
  private readonly store: ReaderStore;
  private readonly options: ReaderControllerOptions;
  private readonly doc: Document;
  private readonly createRenderer: CreateRenderer;

  private host: HTMLElement | undefined;
  // Each renderer owns its own child element; a flow switch discards the whole slot subtree, so
  // teardown never depends on what `destroy()` leaves in the host. Renderers are created fresh per
  // flow (never reused after `destroy()`).
  private slot: HTMLElement | undefined;
  private active: ReaderRenderer | undefined;
  private activeFlow: ReaderState["flow"] | undefined;

  private unsubscribe: (() => void) | undefined;
  private scheduled = false;
  private prev: Watched | undefined;
  private lastSettings: ReaderSettings | undefined;
  private pendingSettingsBase: ReaderSettings | undefined;
  // The mount-time snapshot is inert. Later changes that arrive before the first render lands are
  // coalesced and applied once that renderer is ready.
  private started = false;

  constructor(options: ReaderControllerOptions) {
    this.store = options.store;
    this.options = options;
    this.doc = options.doc ?? document;
    this.createRenderer = options.createRenderer ?? defaultCreateRenderer;
  }

  /** Mount into `host`. Subscribes to store deltas and reconciles them. */
  mount(host: HTMLElement): void {
    this.host = host;
    this.prev = undefined;
    this.reconcile(); // handle whatever state we mount into (e.g. an already-loaded book)
    this.unsubscribe = this.store.subscribe(() => this.schedule());
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.active?.destroy();
    this.slot?.remove();
    this.active = this.slot = this.host = undefined;
    this.activeFlow = undefined;
    this.started = false;
    this.lastSettings = undefined;
    this.pendingSettingsBase = undefined;
  }

  // Diff the current settings snapshot against the last and route to the cheapest renderer update (mirrors `reconcile()`'s store-delta routing). The wrapper runs this in an effect that reads `settings.get()`, so it re-runs on any settings change.
  //
  // Cost tiers, by what CSS the change touches:
  //   • publisher-styles → rebuild (the injected CSS source changes).
  //   • geometry (font size/family, line-height, margins, columns, direction) → reflow.
  //     Paginated must re-measure multicol (position-preserving render); continuous refreshes
  //     layout (CSS vars + refit) in place.
  //   • force-color → repaint only (no reflow); both renderers just flip a class.
  //     Page/background colors ride inherited CSS custom properties and need no engine call at all.
  // No-ops until the first render, so the mount-time effect run is inert.
  applySettings(next: ReaderSettings): void {
    const prev = this.lastSettings;
    this.lastSettings = next;
    const active = this.active;
    if (!prev || !active) return;
    if (!this.started) {
      this.pendingSettingsBase ??= prev;
      return;
    }

    this.applySettingsDiff(active, prev, next);
  }

  private applySettingsDiff(active: ReaderRenderer, prev: ReaderSettings, next: ReaderSettings): void {
    // CSS source changed → full rebuild (both renderers).
    if (prev.publisherStyles !== next.publisherStyles) {
      void active.render();
      return;
    }

    const layout = layoutChanged(prev, next, this.activeFlow ?? "paginated");
    const color = prev.forceTextColor !== next.forceTextColor;

    if (this.activeFlow === "paginated") {
      // Reflow needs a re-measure (which also re-applies color); a lone color change is a cheap repaint.
      if (layout) void active.render({ preservePosition: true });
      else if (color) active.applyTextColor?.();
    } else {
      // Independent cheap paths — `refreshLayout` doesn't touch color, so both may run together.
      if (layout) active.scheduleLayoutRefresh?.();
      if (color) active.applyTextColor?.();
    }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.reconcile();
    });
  }

  private reconcile(): void {
    if (!this.host) return;
    const s = this.store.getState();
    const cur = watch(s);
    const prev = this.prev;
    this.prev = cur;

    if (cur.status !== "ready" || !cur.book) return;

    // Renderer lifecycle: (re)create for the current flow. A flow switch tears the old one down and forces a fresh full render.
    const switched = this.ensureRenderer(cur.flow);
    const active = this.active;
    if (!active) return;

    if (switched || !prev || cur.book !== prev.book) {
      void this.render(active);
      return;
    }

    if (this.activeFlow === "paginated") {
      // Chapter change (nav) or a restore into a different section → full render; `render()` applies
      // any pending restore at the end.
      if (cur.spineIndex !== prev.spineIndex) {
        void this.render(active);
      } else if (cur.navigationSeq !== prev.navigationSeq) {
        active.applyPage?.(); // page turn within the chapter
      } else if (this.restoreQueued(cur, prev)) {
        void active.applyPendingRestore?.(); // restore within the current chapter
      }
    } else {
      // Continuous navigation and restore are renderer-owned seeks (including window shifts).
      // `spineIndex` alone changes on passive scroll, so only act on `navigationSeq`.
      if (cur.navigationSeq !== prev.navigationSeq) {
        active.scrollToCurrentTarget?.();
      } else if (this.restoreQueued(cur, prev)) {
        void active.applyPendingRestore?.();
      }
    }

    // Host annotations changed with no navigation → cheap repaint (a full render / page
    // turn / restore above already repaints, so a double here is harmless and rare).
    if (cur.highlights !== prev.highlights) active.applyHighlights?.();
  }

  private restoreQueued(cur: Watched, prev: Watched): boolean {
    return cur.restoreToken !== prev.restoreToken && cur.restoreStatus === "pending";
  }

  private async render(active: ReaderRenderer): Promise<void> {
    await active.render();
    if (this.active !== active || !this.host) return;
    this.started = true;

    const base = this.pendingSettingsBase;
    const latest = this.lastSettings;
    this.pendingSettingsBase = undefined;
    if (base && latest) this.applySettingsDiff(active, base, latest);
  }

  /** Ensure `active` matches `flow`, mounting a fresh renderer into a fresh slot on a switch. Returns `true` when the active renderer changed (caller forces a render). */
  private ensureRenderer(flow: ReaderState["flow"]): boolean {
    if (this.active && this.activeFlow === flow) return false;
    if (!this.host) return false;

    this.active?.destroy();
    this.slot?.remove();
    this.started = false;

    const slot = this.doc.createElement("div");
    slot.style.cssText = "position:relative;width:100%;height:100%";
    this.host.appendChild(slot);
    this.slot = slot;

    this.active = this.createRenderer(flow, {
      store: this.store,
      settings: this.options.settings,
      extensions: this.options.extensions,
      spreadPartnerFor: this.options.spreadPartnerFor,
      doc: this.doc,
    });
    this.activeFlow = flow;
    this.active.mount(slot);
    return true;
  }
}

/** Geometry-affecting settings (continuous can refresh these in place). */
function layoutChanged(a: ReaderSettings, b: ReaderSettings, flow: ReaderState["flow"]): boolean {
  const shared =
    a.fontSizePx !== b.fontSizePx ||
    a.fontId !== b.fontId ||
    a.lineHeight !== b.lineHeight ||
    a.sideMarginPct !== b.sideMarginPct ||
    a.blockMarginPct !== b.blockMarginPct;
  return shared || (flow === "paginated" && (a.pageColumns !== b.pageColumns || a.readingDirection !== b.readingDirection));
}
