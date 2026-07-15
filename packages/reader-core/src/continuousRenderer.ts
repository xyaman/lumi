// Framework-neutral continuous (scroll) renderer. All sections render into one shadow
// root under a single content shell, each in a per-spine <section> wrapper so TOC
// jumps, offsets, and progress stay stable.

import { type Book, type Epub, resolveHref, type Section, type SpineItem } from "@lostcoords/lumi-epub";
import { AnnotationPainter, atomAtClientPoint, type PaintSection, spanCoversAtom } from "./annotations";
import { type AtomUnit, collectAtomUnits } from "./atomMap";
import { buildPosition } from "./positionBuilder";
import type { PointerContext, ReaderExtension, RenderContext, SettingsPort } from "./ports";
import {
  createBlobUrlStore,
  HOST_CSS,
  loadCombinedPublisherCss,
  loadSpineDocument,
  PAD_BOTTOM,
  PAD_TOP,
  type PublisherCssSource,
  READER_SHARED_SHEETS,
  RESIZE_DEBOUNCE_MS,
  rewriteResourceUrls,
  USER_CSS,
  WRITING_MODE_CLASS_RE,
} from "./renderShared";
import type { ReaderStore } from "./store";
import type { ReaderPosition } from "./types";

const FONT_READY_TIMEOUT_MS = 500;
const SECTION_STYLE = "display:block;margin:0;padding:0 0 1.5rem";
const IMAGE_SECTION_STYLE = `${SECTION_STYLE};min-height:var(--lumi-ch)`;

/** Geometry + typography inputs the renderer feeds into CSS variables. */
type LayoutMetrics = {
  contentW: number;
  contentH: number;
  padX: number;
  fontSizePx: number;
  lineHeight: number;
  fontCssValue: string | null;
};

/** SVG whose `viewBox` + percent sizing requires the renderer to derive explicit pixel dimensions. */
type FitSvg = { el: SVGSVGElement; ratio: number };

/** A mounted fragment with its id (for anchor resolution). */
type FragmentRef = { id: string; el: Element };

/** Per-section rendering state owned by the continuous renderer. */
type ContinuousSection = {
  /** Flow index into `book.sections`. */
  spineIndex: number;
  href: string;
  sectionEl: HTMLElement;
  contentEl: HTMLElement;
  fragmentRefs: FragmentRef[];
  fitSvgs: FitSvg[];
};

/** Section after parse+rewrite, ready to be appended to the content shell. */
type PreparedSection = {
  section: ContinuousSection;
  publisherCssSource: PublisherCssSource;
};

/** Configuration for `ContinuousRenderer`. */
export type ContinuousRendererOptions = {
  store: ReaderStore;
  settings: SettingsPort;
  extensions?: ReaderExtension[];
  doc?: Document;
};

/** Scroll-based renderer. */
export class ContinuousRenderer {
  private readonly store: ReaderStore;
  private readonly settings: SettingsPort;
  private readonly extensions: ReaderExtension[];
  private readonly doc: Document;

  private scrollEl: HTMLElement | undefined;
  private shadow: ShadowRoot | undefined;
  // The non-scrolling mount host (positioned): the page-mark overlay anchors here.
  private mountHost: HTMLElement | undefined;
  private contentShell: HTMLElement | null = null;
  private renderedSections: ContinuousSection[] = [];
  private readonly painter: AnnotationPainter;
  private readonly blobUrls: string[] = [];

  private renderToken = 0;
  private layoutRaf = 0;
  private scrollRaf = 0;
  private resizeObserver: ResizeObserver | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private insets = { top: PAD_TOP, bottom: PAD_BOTTOM };

  constructor(options: ContinuousRendererOptions) {
    this.store = options.store;
    this.settings = options.settings;
    this.extensions = options.extensions ?? [];
    this.doc = options.doc ?? document;
    this.painter = new AnnotationPainter(this.doc);
  }

  /** Mount into `host`, building the scroll element + shadow root on first call. */
  mount(host: HTMLElement): void {
    this.mountHost = host;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    if (!this.scrollEl) {
      const scroll = this.doc.createElement("div");
      scroll.setAttribute("role", "presentation");
      this.scrollEl = scroll;
      this.updateInsets(host);
      this.applyScrollerStyle();
      host.appendChild(scroll);

      this.shadow = scroll.attachShadow({ mode: "open" });
      this.shadow.addEventListener("click", this.onShadowClick);
      for (const ext of this.extensions) ext.onShadow?.(this.shadow);

      scroll.addEventListener("scroll", this.onScroll, { passive: true });
    }
    this.observeResize(host);
  }

  /** Tear down observers, listeners, blob URLs, and extensions. */
  destroy(): void {
    this.renderToken++;
    this.painter.destroy();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
    if (this.layoutRaf !== 0) cancelAnimationFrame(this.layoutRaf);
    if (this.scrollRaf !== 0) cancelAnimationFrame(this.scrollRaf);
    if (this.scrollEl) this.scrollEl.removeEventListener("scroll", this.onScroll);
    if (this.shadow) this.shadow.removeEventListener("click", this.onShadowClick);
    for (const ext of this.extensions) {
      ext.onShadow?.(null);
      ext.onDestroy?.();
    }
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls.length = 0;
    this.contentShell = null;
    this.renderedSections = [];
    this.mountHost = undefined;
  }

  private observeResize(host: HTMLElement): void {
    if (typeof ResizeObserver === "undefined") return;
    let prevW = host.clientWidth;
    let prevH = host.clientHeight;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || (r.width === prevW && r.height === prevH)) return;
      prevW = r.width;
      prevH = r.height;
      if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.updateInsets(host);
        this.applyScrollerStyle();
        this.scheduleLayoutRefresh();
      }, RESIZE_DEBOUNCE_MS);
    });
    this.resizeObserver.observe(host);
  }

  // Rebuild the whole scroll body when the book/source or the publisher-CSS toggle changes; geometry/font/color updates use the cheaper `refreshLayout` path.
  async render(): Promise<void> {
    const myToken = ++this.renderToken;
    const st = this.store.getState();
    const book = st.book;
    const scroll = this.scrollEl;
    const shadow = this.shadow;
    if (!book || !scroll || !shadow) return;
    const epub = book.epub;
    const s = this.settings.get();

    const preserveFraction = shadow.childElementCount > 0;
    const savedPosition = preserveFraction && st.restore.status === "idle" ? this.capturePosition() : null;
    const cont = this.store.getState().continuous;
    const savedFraction =
      preserveFraction && !savedPosition && cont.scrollRange > 0 ? cont.scrollTop / cont.scrollRange : null;

    const blobStore = createBlobUrlStore();
    const content = this.doc.createElement("div");

    const prepared = (
      await Promise.all(book.sections.map((section, i) => this.prepareSection(section, i, epub, blobStore)))
    ).filter((p): p is PreparedSection => p !== null);
    if (myToken !== this.renderToken) return this.revokeAll(blobStore.urls);

    // One shared publisher sheet after prep so duplicate book CSS parses once.
    const publisherCss = await loadCombinedPublisherCss(
      prepared.map((p) => p.publisherCssSource),
      epub,
      s.publisherStyles,
      blobStore,
    );
    if (myToken !== this.renderToken) return this.revokeAll(blobStore.urls);

    const activeFontId = await this.prepareFont(s.fontId, myToken);
    if (myToken !== this.renderToken) return this.revokeAll(blobStore.urls);

    const committed = prepared.map((p) => p.section);
    const metrics = this.getLayoutMetrics(scroll, activeFontId);
    this.applyContentShellLayout(content, metrics);
    for (const section of committed) fitSectionSvgs(section, metrics);
    content.append(...committed.map((section) => section.sectionEl));

    const shadowChildren: Node[] = [];
    let fallbackUserStyleEl: HTMLStyleElement | null = null;
    if (READER_SHARED_SHEETS) {
      shadow.adoptedStyleSheets = READER_SHARED_SHEETS;
    } else {
      shadowChildren.push(this.styleEl(HOST_CSS));
      fallbackUserStyleEl = this.styleEl(USER_CSS);
    }
    if (publisherCss) shadowChildren.push(this.styleEl(publisherCss));
    if (fallbackUserStyleEl) shadowChildren.push(fallbackUserStyleEl);

    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls.length = 0;
    this.blobUrls.push(...blobStore.urls);
    this.contentShell = content;
    this.renderedSections = committed;
    this.applyReaderFontClass(activeFontId);
    this.applyTextColor();

    shadow.replaceChildren(...shadowChildren, content);
    this.refreshOffsets(scroll);
    this.notifyRender(book, committed, myToken);

    const restored = await this.applyPendingRestore();
    if (myToken !== this.renderToken) return;

    if (restored) this.syncScrollState();
    else if (this.store.getState().pendingFragment !== null) this.scrollToCurrentTarget();
    else this.applyInitialScrollPosition(scroll, savedPosition, savedFraction);
    this.notifyScroll();
    this.paintAnnotations();
  }

  private async prepareSection(
    section: Section,
    spineIndex: number,
    epub: Epub,
    blobStore: ReturnType<typeof createBlobUrlStore>,
  ): Promise<PreparedSection | null> {
    const spineItem: SpineItem = epub.spine[section.spineIndex];
    const loaded = await loadSpineDocument(spineItem, epub);
    if (!loaded) return null;

    const { doc, htmlEl, bodyEl, baseDir, htmlClasses, bodyClasses, lang } = loaded;
    const allClasses = `${htmlClasses} ${bodyClasses}`;
    const imageOnly = section.isImageOnly;

    await rewriteResourceUrls(doc, epub, baseDir, blobStore);

    const sectionEl = this.doc.createElement("section");
    sectionEl.style.cssText = imageOnly ? IMAGE_SECTION_STYLE : SECTION_STYLE;
    sectionEl.dataset.lumiBaseDir = baseDir;
    sectionEl.dataset.lumiSpineIndex = String(spineIndex);

    const contentEl = this.doc.createElement("div");
    if (imageOnly) {
      contentEl.className = "lumi-content lumi-image-only";
    } else {
      // Continuous is always horizontal; strip publisher writing-mode helpers.
      contentEl.className = `${(allClasses ? `lumi-content ${allClasses}` : "lumi-content").replace(WRITING_MODE_CLASS_RE, "")} hltr`;
      contentEl.style.writingMode = "horizontal-tb";
    }
    if (lang) contentEl.setAttribute("lang", lang);
    contentEl.dataset.lumiSpineIndex = String(spineIndex);
    contentEl.dataset.lumiSpineHref = section.href;

    const fitSvgs = collectFitSvgs(bodyEl);
    if (imageOnly) {
      for (const el of bodyEl.querySelectorAll<HTMLElement>("img, svg")) {
        if (/(?:^|\s)keep-space/.test(el.getAttribute("class") ?? "")) continue;
        if (!el.id) {
          const idAncestor = el.parentElement?.closest("[id]");
          if (idAncestor) el.id = idAncestor.id;
        }
        contentEl.appendChild(el);
      }
    } else {
      while (bodyEl.firstChild) contentEl.appendChild(bodyEl.firstChild);
    }

    const fragmentRefs: FragmentRef[] = [];
    for (const el of contentEl.querySelectorAll("[id]")) fragmentRefs.push({ id: el.id, el });
    sectionEl.appendChild(contentEl);

    return {
      section: { spineIndex, href: section.href, sectionEl, contentEl, fragmentRefs, fitSvgs },
      publisherCssSource: { htmlEl, baseDir, isImageOnly: imageOnly, cssHrefs: section.cssHrefs },
    };
  }

  /** Schedule a rAF-driven in-place layout refresh. Use for geometry/font changes; cheaper than `render()`. */
  scheduleLayoutRefresh(): void {
    if (this.layoutRaf !== 0) cancelAnimationFrame(this.layoutRaf);
    this.layoutRaf = requestAnimationFrame(() => {
      this.layoutRaf = 0;
      this.refreshLayout();
    });
  }

  // Keep the existing DOM; refresh inherited geometry vars and refit SVGs. Use for font/line-height/margin changes.
  refreshLayout(): void {
    const scroll = this.scrollEl;
    if (!scroll || !this.contentShell) return;
    const st = this.store.getState();

    const savedPosition = st.restore.status === "idle" ? this.capturePosition() : null;
    const cont = st.continuous;
    const savedFraction = !savedPosition && cont.scrollRange > 0 ? cont.scrollTop / cont.scrollRange : null;

    const metrics = this.getLayoutMetrics(scroll, this.settings.get().fontId);
    this.applyContentShellLayout(this.contentShell, metrics);
    this.applyReaderFontClass(this.settings.get().fontId);
    for (const section of this.renderedSections) fitSectionSvgs(section, metrics);
    this.refreshOffsets(scroll);

    if (savedPosition) this.applyPositionToScroll(savedPosition);
    else if (savedFraction !== null) {
      scroll.scrollTop = savedFraction * Math.max(scroll.scrollHeight - scroll.clientHeight, 0);
    }
    this.syncScrollState();
    const book = st.book;
    if (book) this.notifyRender(book, this.renderedSections, this.renderToken);
    this.notifyScroll();
    this.paintAnnotations();
  }

  /** Force-color toggle: no relayout, just class flips. */
  applyTextColor(): void {
    const force = this.settings.get().forceTextColor;
    for (const section of this.renderedSections) {
      const imageOnly = section.contentEl.classList.contains("lumi-image-only");
      section.contentEl.classList.toggle("lumi-force-colors", force && !imageOnly);
    }
  }

  /** Repaint host annotations across all mounted sections against the live scroll. */
  private paintAnnotations(): void {
    const host = this.mountHost;
    const book = this.store.getState().book;
    if (!host || !book || this.renderedSections.length === 0) return;
    const sections: PaintSection[] = this.renderedSections.map((s) => {
      const section = book.sections[s.spineIndex];
      return { spineIndex: s.spineIndex, content: s.contentEl, atomCount: section ? section.endAtom - section.startAtom : 0 };
    });
    const { highlights } = this.store.getState();
    this.painter.paintHighlights(sections, highlights);
    // The mount host has no shadow (the shadow lives on the inner scroller), so the
    // overlay renders as a light-DOM child of it and lays out against it.
    this.painter.paintMarks(host, host, sections, highlights);
  }

  /** Cheap repaint path used when only the host's highlight set changed. */
  applyHighlights(): void {
    this.paintAnnotations();
  }

  private applyReaderFontClass(fontId: string): void {
    const override = this.settings.isFontOverride(fontId);
    for (const section of this.renderedSections) {
      const imageOnly = section.contentEl.classList.contains("lumi-image-only");
      section.contentEl.classList.toggle("lumi-reader-font-override", override && !imageOnly);
    }
  }

  private async prepareFont(requestedFontId: string, token: number): Promise<string> {
    const loaded = await this.settings.loadFont(requestedFontId);
    if (token !== this.renderToken) return requestedFontId;
    if (loaded) return requestedFontId;
    if (this.settings.get().fontId === requestedFontId) this.settings.onFontFallback?.(this.settings.bookFontId);
    return this.settings.bookFontId;
  }

  private getLayoutMetrics(scroll: HTMLElement, fontId: string): LayoutMetrics {
    const s = this.settings.get();
    const viewportW = Math.max(scroll.clientWidth, 1);
    const viewportH = Math.max(scroll.clientHeight, 1);
    const padX = Math.min(Math.max((viewportW * s.sideMarginPct) / 100, 12), viewportW * 0.3);
    return {
      contentW: Math.max(viewportW - 2 * padX, 1),
      contentH: viewportH,
      padX,
      fontSizePx: s.fontSizePx,
      lineHeight: s.lineHeight,
      fontCssValue: this.settings.fontCssValue(fontId),
    };
  }

  private applyContentShellLayout(content: HTMLElement, m: LayoutMetrics): void {
    content.style.cssText =
      `display:block;box-sizing:border-box;min-height:100%;padding:0 ${m.padX}px;` +
      `--lumi-cw:${m.contentW}px;--lumi-ch:${m.contentH}px;` +
      `--lumi-v-margin-cap:${m.contentH * 0.18}px;--reader-font-size:${m.fontSizePx}px;` +
      `--reader-line-height:${m.lineHeight};` +
      (m.fontCssValue ? `--reader-font-family:${m.fontCssValue};` : "");
  }

  private refreshOffsets(scroll: HTMLElement): void {
    const spineOffsets: number[] = [];
    const fragmentOffsets: Map<string, number>[] = [];
    for (const section of this.renderedSections) {
      const sectionTop = section.sectionEl.offsetTop;
      spineOffsets[section.spineIndex] = sectionTop;
      const offsets = new Map<string, number>();
      for (const fragment of section.fragmentRefs) {
        offsets.set(fragment.id, sectionTop + offsetTopWithinContent(fragment.el, section.contentEl));
      }
      fragmentOffsets[section.spineIndex] = offsets;
    }
    this.store.setContinuousMetrics({
      spineOffsets,
      fragmentOffsets,
      viewportExtent: scroll.clientHeight,
      scrollRange: Math.max(scroll.scrollHeight - scroll.clientHeight, 1),
    });
  }

  private syncScrollState(): void {
    const scroll = this.scrollEl;
    if (!scroll) return;
    const scrollTop = scroll.scrollTop;
    this.store.setContinuousMetrics({
      scrollTop,
      scrollRange: Math.max(scroll.scrollHeight - scroll.clientHeight, 1),
      viewportExtent: scroll.clientHeight,
    });

    const spineOffsets = this.store.getState().continuous.spineOffsets;
    if (this.renderedSections.length === 0 || spineOffsets.length === 0) return;

    const marker = scrollTop + Math.min(scroll.clientHeight * 0.25, 160);
    let visibleSpine = 0;
    for (let i = 0; i < spineOffsets.length; i++) {
      if ((spineOffsets[i] ?? Number.POSITIVE_INFINITY) <= marker) visibleSpine = i;
      else break;
    }
    this.store.setVisibleSpineIndex(visibleSpine);
  }

  /** Scroll to the queued navigation target, including its pending fragment. */
  scrollToCurrentTarget(): void {
    const scroll = this.scrollEl;
    if (!scroll) return;
    const st = this.store.getState();
    const spineOffsets = st.continuous.spineOffsets;
    const spineIndex = Math.max(Math.min(st.spineIndex, spineOffsets.length - 1), 0);
    let target = spineOffsets[spineIndex] ?? 0;
    if (st.pendingFragment !== null) {
      target = st.continuous.fragmentOffsets[spineIndex]?.get(st.pendingFragment) ?? target;
    }
    scroll.scrollTo({ top: target, behavior: "auto" });
    this.store.clearPendingFragment();
    this.syncScrollState();
    this.reportCurrentPosition();
  }

  private applyInitialScrollPosition(
    scroll: HTMLElement,
    savedPosition: ReaderPosition | null,
    savedFraction: number | null,
  ): void {
    if (savedPosition && this.applyPositionToScroll(savedPosition)) return this.syncScrollState();

    const st = this.store.getState();
    if (
      st.restore.status === "idle" &&
      st.readingPoint !== null &&
      this.positionMatchesCurrentSpine(st.readingPoint) &&
      this.applyPositionToScroll(st.readingPoint)
    ) {
      return this.syncScrollState();
    }
    if (savedFraction !== null) {
      scroll.scrollTop = savedFraction * Math.max(scroll.scrollHeight - scroll.clientHeight, 0);
      return this.syncScrollState();
    }
    scroll.scrollTop = st.continuous.spineOffsets[st.spineIndex] ?? 0;
    this.syncScrollState();
  }

  /** Snapshot the current scroll position as a `ReaderPosition` (or `null` when no content is mounted). */
  capturePosition(): ReaderPosition | null {
    const scroll = this.scrollEl;
    const st = this.store.getState();
    if (!scroll || !st.book || this.renderedSections.length === 0) return null;

    const section = this.sectionForScrollTop(scroll.scrollTop);
    if (!section) return null;
    if (section.contentEl.classList.contains("lumi-image-only")) {
      return buildPosition(st.book, section.spineIndex, section.href, 0);
    }

    const units = collectAtomUnits(section.contentEl);
    if (units.length === 0) return null;
    const sectionTop = st.continuous.spineOffsets[section.spineIndex] ?? section.sectionEl.offsetTop;
    const targetTop = scroll.scrollTop;

    let bestAtom = units[0].atomStart;
    for (const unit of units) {
      const top = this.atomUnitTop(unit, section);
      if (top === null) continue;
      bestAtom = unit.atomStart;
      if (sectionTop + top >= targetTop - 1) break;
    }
    return buildPosition(st.book, section.spineIndex, section.href, bestAtom);
  }

  private reportCurrentPosition(): void {
    const st = this.store.getState();
    if (st.status !== "ready" || st.restore.status !== "idle") return;
    const position = this.capturePosition();
    if (position) this.store.reportPosition(position);
  }

  private sectionForScrollTop(scrollTop: number): ContinuousSection | null {
    const spineOffsets = this.store.getState().continuous.spineOffsets;
    let best: ContinuousSection | null = null;
    for (const section of this.renderedSections) {
      const sectionTop = spineOffsets[section.spineIndex] ?? section.sectionEl.offsetTop;
      if (sectionTop <= scrollTop + 1) best = section;
      else break;
    }
    return best ?? this.renderedSections[0] ?? null;
  }

  /** Land on the restore target's section/atom. Returns `false` when interrupted or no target. */
  async applyPendingRestore(): Promise<boolean> {
    const scroll = this.scrollEl;
    const st = this.store.getState();
    const restore = st.restore;
    if (restore.status !== "pending" || !restore.point || !scroll) return false;

    const section = this.sectionForPosition(restore.point);
    // Cancel rather than leave the restore "pending" (which would freeze position
    // reporting) if its target section isn't mounted.
    if (!section) {
      this.store.setRestoreStatus("idle");
      return false;
    }

    const token = this.renderToken;
    this.store.setRestoreStatus("applying");
    await this.waitForStableLayout();
    if (token !== this.renderToken || scroll !== this.scrollEl) {
      this.resetInterruptedRestore(restore.token);
      return false;
    }

    this.refreshOffsets(scroll);
    const target = this.scrollTargetForPosition(restore.point, section);
    if (target === null) {
      this.resetInterruptedRestore(restore.token);
      return false;
    }

    scroll.scrollTo({ top: target, behavior: "auto" });
    this.syncScrollState();
    this.store.setRestoreStatus("settling");
    await nextFrame();
    if (token !== this.renderToken || scroll !== this.scrollEl) {
      this.resetInterruptedRestore(restore.token);
      return false;
    }
    this.syncScrollState();
    this.store.setRestoreStatus("idle");
    return true;
  }

  private sectionForPosition(position: ReaderPosition): ContinuousSection | null {
    return (
      this.renderedSections.find((s) => s.href === position.locator.spineHref) ??
      this.renderedSections.find((s) => s.spineIndex === position.locator.spineIndex) ??
      null
    );
  }

  private scrollTargetForPosition(position: ReaderPosition, section: ContinuousSection): number | null {
    const spineOffsets = this.store.getState().continuous.spineOffsets;
    const sectionTop = spineOffsets[section.spineIndex] ?? section.sectionEl.offsetTop;
    if (section.contentEl.classList.contains("lumi-image-only") && position.locator.atomOffset === 0) {
      return sectionTop;
    }
    const units = collectAtomUnits(section.contentEl);
    const unit = unitForAtomOffset(units, position.locator.atomOffset);
    if (!unit) return null;
    const unitTop = this.atomUnitTop(unit, section);
    return unitTop === null ? null : sectionTop + unitTop;
  }

  private applyPositionToScroll(position: ReaderPosition): boolean {
    const scroll = this.scrollEl;
    const section = this.sectionForPosition(position);
    if (!scroll || !section) return false;
    const target = this.scrollTargetForPosition(position, section);
    if (target === null) return false;
    scroll.scrollTop = target;
    return true;
  }

  private positionMatchesCurrentSpine(position: ReaderPosition): boolean {
    const st = this.store.getState();
    const currentHref = this.renderedSections.find((s) => s.spineIndex === st.spineIndex)?.href;
    return (
      position.locator.spineIndex === st.spineIndex || (!!currentHref && position.locator.spineHref === currentHref)
    );
  }

  private atomUnitTop(unit: AtomUnit, section: ContinuousSection): number | null {
    const el = unit.kind === "replaced" ? unit.node : unit.node.parentElement;
    if (!el) return null;
    return offsetTopWithinContent(el, section.contentEl);
  }

  private resetInterruptedRestore(token: number): void {
    if (this.store.getState().restore.token === token) this.store.setRestoreStatus("pending");
  }

  private async waitForStableLayout(): Promise<void> {
    const fontReady = "fonts" in this.doc ? this.doc.fonts.ready : Promise.resolve();
    await Promise.race([fontReady.catch(() => undefined), delay(FONT_READY_TIMEOUT_MS)]);
    await nextFrame();
    await nextFrame();
  }

  /** Continuous notifies per section — each has its own atom coordinate space. */
  private notifyRender(book: Book, sections: ContinuousSection[], token: number): void {
    if (this.extensions.length === 0) return;
    for (const s of sections) {
      const ctx = this.makeRenderContext(book, s, token);
      for (const ext of this.extensions) ext.onRender?.(ctx);
    }
  }

  private notifyScroll(): void {
    if (!this.shadow) return;
    for (const ext of this.extensions) ext.onScroll?.(this.shadow);
  }

  private makeRenderContext(book: Book, s: ContinuousSection, token: number): RenderContext {
    let units: AtomUnit[] | null = null;
    const content = s.contentEl;
    return {
      shadow: this.shadow as ShadowRoot,
      content,
      book,
      section: book.sections[s.spineIndex],
      spineIndex: s.spineIndex,
      isImageOnly: content.classList.contains("lumi-image-only"),
      atomUnits: () => (units ??= collectAtomUnits(content)),
      isCurrent: () => token === this.renderToken && this.renderedSections.includes(s),
    };
  }

  private readonly onScroll = (): void => {
    if (this.scrollRaf !== 0) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.syncScrollState();
      this.reportCurrentPosition();
      this.notifyScroll();
      this.paintAnnotations();
    });
  };

  private readonly onShadowClick = (e: Event): void => {
    const target = e.target as Element | null;

    const anchor = target?.closest<HTMLAnchorElement>("a[href]");
    if (anchor) {
      this.handleAnchor(anchor, e);
      return;
    }

    const sectionEl = target?.closest<HTMLElement>("[data-lumi-spine-index]");
    const spineIndex = sectionEl ? Number(sectionEl.dataset.lumiSpineIndex) : -1;
    const section = this.renderedSections.find((s) => s.spineIndex === spineIndex);
    const book = this.store.getState().book;
    if (!section || !book) return;

    const me = e as MouseEvent;
    if (this.extensions.length > 0) {
      const ctx: PointerContext = {
        ...this.makeRenderContext(book, section, this.renderToken),
        clientX: me.clientX,
        clientY: me.clientY,
      };
      for (const ext of this.extensions) {
        if (ext.onPointerDown?.(ctx, e) === true) return;
      }
    }
    // Core default (runs after extensions): activate a tapped highlight.
    this.activateHighlightAt(section, me.clientX, me.clientY);
  };

  private activateHighlightAt(section: ContinuousSection, clientX: number, clientY: number): void {
    const st = this.store.getState();
    if (st.highlights.length === 0) return;
    const atom = atomAtClientPoint(this.doc, section.contentEl, clientX, clientY);
    if (atom === null) return;
    const hit = st.highlights.find((span) => spanCoversAtom(span, section.spineIndex, atom));
    if (hit) this.store.activateHighlight(hit.id);
  }

  private handleAnchor(anchor: HTMLAnchorElement, e: Event): void {
    const raw = anchor.getAttribute("href");
    if (!raw) return;
    e.preventDefault();

    if (/^(?:https?|mailto|tel):/i.test(raw)) {
      window.open(raw, "_blank", "noopener,noreferrer");
      return;
    }

    const sectionEl = anchor.closest<HTMLElement>("[data-lumi-spine-index]");
    const spineIndex = sectionEl ? Number(sectionEl.dataset.lumiSpineIndex) : -1;
    const baseDir = sectionEl?.dataset.lumiBaseDir ?? "";

    if (raw.startsWith("#")) {
      if (spineIndex >= 0) this.store.jumpToNavEntry(spineIndex, raw.slice(1));
      return;
    }

    const hashIdx = raw.indexOf("#");
    const path = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
    const fragment = hashIdx === -1 ? null : raw.slice(hashIdx + 1);
    const abs = resolveHref(baseDir, path);
    if (abs) this.store.jumpToHref(abs, fragment);
  }

  private updateInsets(host: HTMLElement): void {
    const s = this.settings.get();
    const rootStyle = getComputedStyle(this.doc.documentElement);
    const chromeTop = PAD_TOP + (parseFloat(rootStyle.getPropertyValue("--sai-top")) || 0);
    const chromeBottom = PAD_BOTTOM + (parseFloat(rootStyle.getPropertyValue("--sai-bottom")) || 0);
    const availableH = Math.max(Math.max(host.clientHeight, 1) - chromeTop - chromeBottom, 1);
    const gutter = Math.min(Math.max((availableH * s.blockMarginPct) / 100, 0), availableH * 0.3);
    this.insets = { top: chromeTop + gutter, bottom: chromeBottom + gutter };
  }

  private applyScrollerStyle(): void {
    if (!this.scrollEl) return;
    this.scrollEl.style.cssText = `position:absolute;left:0;right:0;top:${this.insets.top}px;bottom:${this.insets.bottom}px;height:auto;overflow:auto;`;
  }

  private styleEl(text: string): HTMLStyleElement {
    const node = this.doc.createElement("style");
    node.textContent = text;
    return node;
  }

  private revokeAll(urls: string[]): void {
    for (const u of urls) URL.revokeObjectURL(u);
  }
}

function collectFitSvgs(bodyEl: HTMLElement): FitSvg[] {
  const fitSvgs: FitSvg[] = [];
  for (const svg of bodyEl.querySelectorAll<SVGSVGElement>("svg")) {
    const dims = (svg.getAttribute("width") ?? "") + (svg.getAttribute("height") ?? "");
    const vb = svg.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
    if (!dims.includes("%") || vb?.length !== 4 || !(vb[2] > 0 && vb[3] > 0)) continue;
    fitSvgs.push({ el: svg, ratio: vb[2] / vb[3] });
  }
  return fitSvgs;
}

function fitSectionSvgs(section: ContinuousSection, m: LayoutMetrics): void {
  for (const { el, ratio } of section.fitSvgs) {
    const [w, h] = m.contentW / ratio <= m.contentH ? [m.contentW, m.contentW / ratio] : [m.contentH * ratio, m.contentH];
    el.setAttribute("width", String(Math.floor(w)));
    el.setAttribute("height", String(Math.floor(h)));
  }
}

function offsetTopWithinContent(el: Element, contentEl: HTMLElement): number {
  if (!(el instanceof HTMLElement)) {
    return el.getBoundingClientRect().top - contentEl.getBoundingClientRect().top;
  }
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== contentEl) {
    top += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  return top;
}

function unitForAtomOffset(units: AtomUnit[], atomOffset: number): AtomUnit | null {
  return (
    units.find((u) => atomOffset >= u.atomStart && atomOffset < u.atomEnd) ??
    units.find((u) => u.atomStart >= atomOffset) ??
    units.at(-1) ??
    null
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
