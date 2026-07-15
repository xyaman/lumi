// Framework-neutral paginated renderer. State lives in the injected ReaderStore;
// the renderer reads `store.getState()` and reports geometry via
// `setPaginatedMetrics()` / `setRestoreStatus()`.

import { type Book, type Epub, resolveHref, type Section, type SpineItem } from "@lumi/epub";
import { type AtomUnit, atomToPoint, collectAtomUnits } from "./atomMap";
import { buildPosition } from "./positionBuilder";
import type { PointerContext, ReaderExtension, RenderContext, SettingsPort } from "./ports";
import {
  HOST_CSS,
  loadPublisherCss,
  loadSpineDocument,
  PAD_BOTTOM,
  PAD_TOP,
  READER_SHARED_SHEETS,
  RESIZE_DEBOUNCE_MS,
  rewriteResourceUrls,
  USER_CSS,
  WRITING_MODE_CLASS_RE,
} from "./renderShared";
import type { ReaderStore } from "./store";
import type { ReaderPosition } from "./types";

const TEXT_NODE = 3;

const SPACER_CSS = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;opacity:0";
const MIN_COLUMN_MAIN_SIZE_PX = 120;

const SPREAD_CSS = `
:where(.lumi-spread-stage) {
  box-sizing: border-box;
  display: grid;
  height: 100%;
  width: 100%;
  overflow: hidden;
  place-items: center;
}
:where(.lumi-svg-spread) {
  display: grid;
  overflow: hidden;
}
:where(.lumi-svg-spread svg) {
  max-height: none !important;
  max-width: none !important;
}
`;

/** Axis along which the section scrolls, plus sign for RTL horizontal scroll (varies by browser). */
type PageGeometry = {
  axis: "x" | "y";
  scrollLeftSign: 1 | -1;
};

/** One side of a pre-paginated SVG spread. */
type SvgSpreadPage = {
  svg: SVGSVGElement;
  ratio: number;
  ids: string[];
};

/** Configuration for `PaginatedRenderer`. */
export type PaginatedRendererOptions = {
  store: ReaderStore;
  settings: SettingsPort;
  extensions?: ReaderExtension[];
  /** Optional pre-paginated spread partner to render to the left of `section`. Returning `null` renders `section` as a normal reflowable/image page. */
  spreadPartnerFor?(section: Section, book: Book): Section | null;
  /** Owning document (defaults to the ambient global). Injectable for testing. */
  doc?: Document;
};

/** Page-by-page renderer. */
export class PaginatedRenderer {
  private readonly store: ReaderStore;
  private readonly settings: SettingsPort;
  private readonly extensions: ReaderExtension[];
  private readonly spreadPartnerFor?: (section: Section, book: Book) => Section | null;
  private readonly doc: Document;

  private host: HTMLElement | undefined;
  private shadow: ShadowRoot | undefined;
  private contentEl: HTMLElement | undefined;
  private currentSection: Section | undefined;
  private pageGeometry: PageGeometry = { axis: "y", scrollLeftSign: 1 };
  private readonly blobUrls: string[] = [];

  // Closure state read by the shadow click listener; refreshed before each mount.
  private currentBaseDir = "";

  // Every render grabs a token; only the render whose token still matches at each checkpoint may mutate the shadow DOM and store.
  private renderToken = 0;

  private resizeObserver: ResizeObserver | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PaginatedRendererOptions) {
    this.store = options.store;
    this.settings = options.settings;
    this.extensions = options.extensions ?? [];
    this.spreadPartnerFor = options.spreadPartnerFor;
    this.doc = options.doc ?? document;
  }

  /** Mount into `host`, creating the shadow root on first call. */
  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.shadow) {
      this.shadow = host.attachShadow({ mode: "open" });
      this.shadow.addEventListener("click", this.onShadowClick);
      for (const ext of this.extensions) ext.onShadow?.(this.shadow);
    }
    this.observeResize(host);
  }

  /** Tear down observers, listeners, blob URLs, and extensions. */
  destroy(): void {
    this.renderToken++;
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
    if (this.shadow) this.shadow.removeEventListener("click", this.onShadowClick);
    for (const ext of this.extensions) {
      ext.onShadow?.(null);
      ext.onDestroy?.();
    }
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls.length = 0;
    this.contentEl = undefined;
    this.currentSection = undefined;
    this.host = undefined;
    this.shadow = undefined;
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
      this.resizeTimer = setTimeout(() => void this.render({ preservePosition: true }), RESIZE_DEBOUNCE_MS);
    });
    this.resizeObserver.observe(host);
  }

  /** Render the store's current section: reflowable/image goes through `renderItem`, a returned spread partner draws a pre-paginated SVG spread. `preservePosition` keeps the in-chapter fraction across a re-render (resize / settings change) instead of honoring `pendingPage`. */
  async render(opts: { preservePosition?: boolean } = {}): Promise<void> {
    const st = this.store.getState();
    const book = st.book;
    if (!this.host || !this.shadow || !book) return;
    const section = book.sections[st.spineIndex];
    if (!section) return;

    const partner = this.spreadPartnerFor?.(section, book) ?? null;
    if (partner) {
      await this.renderSvgSpread(book, section, partner);
      return;
    }
    const preserveFraction = opts.preservePosition || st.paginated.lastRenderedHref === section.href;
    await this.renderItem(book, section, preserveFraction);
  }

  private async renderItem(book: Book, section: Section, preserveFraction: boolean): Promise<void> {
    const myToken = ++this.renderToken;
    const epub = book.epub;
    const host = this.host;
    const shadow = this.shadow;
    if (!epub || !host || !shadow) return;

    const spineItem = epub.spine[section.spineIndex];
    const s = this.settings.get();

    // Capture the preserve fraction BEFORE await — store state may change while loading.
    const paginatedAtStart = this.store.getState().paginated;
    const fraction =
      preserveFraction && paginatedAtStart.totalPagesInChapter > 0
        ? paginatedAtStart.pageInChapter / paginatedAtStart.totalPagesInChapter
        : null;

    const requestedFontId = s.fontId;
    const [loaded, fontLoaded] = await Promise.all([
      loadSpineDocument(spineItem, epub),
      this.settings.loadFont(requestedFontId),
    ]);
    if (myToken !== this.renderToken) return;

    const activeFontId = fontLoaded ? requestedFontId : this.settings.bookFontId;
    if (!fontLoaded && this.settings.get().fontId === requestedFontId) {
      this.settings.onFontFallback?.(this.settings.bookFontId);
    }
    if (!loaded) {
      if (myToken === this.renderToken) shadow.textContent = `Could not render ${section.href}`;
      return;
    }

    // Revoke the previous render's blobs only after we know we're the latest — an in-flight earlier
    // render may still be reading them.
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls.length = 0;
    const { doc, htmlEl, bodyEl, baseDir, htmlClasses, bodyClasses, lang } = loaded;

    const allClasses = `${htmlClasses} ${bodyClasses}`;
    const classWritingMode = /\bvrtl\b/.test(allClasses)
      ? "vertical-rl"
      : /\bhltr\b/.test(allClasses)
        ? "horizontal-tb"
        : "";
    const writingModeOverride =
      s.readingDirection === "vertical"
        ? "vertical-rl"
        : s.readingDirection === "horizontal"
          ? "horizontal-tb"
          : classWritingMode;

    const isImageOnly = section.isImageOnly;

    const cssParts = await loadPublisherCss(
      { htmlEl, baseDir, isImageOnly, cssHrefs: section.cssHrefs },
      epub,
      s.publisherStyles,
      this.blobUrls,
    );
    if (myToken !== this.renderToken) return;

    await rewriteResourceUrls(doc, epub, baseDir, this.blobUrls);
    if (myToken !== this.renderToken) return;

    // Safe-area insets grow the top/bottom chrome on notched devices; fold them into page padding so the
    // first/last lines don't bleed under chrome.
    const rootStyle = getComputedStyle(this.doc.documentElement);
    const chromeTop = PAD_TOP + (parseFloat(rootStyle.getPropertyValue("--sai-top")) || 0);
    const chromeBottom = PAD_BOTTOM + (parseFloat(rootStyle.getPropertyValue("--sai-bottom")) || 0);

    const viewportW = Math.max(host.clientWidth, 1);
    const viewportH = Math.max(host.clientHeight, 1);
    const availableH = Math.max(viewportH - chromeTop - chromeBottom, 1);
    const padX = Math.min(Math.max((viewportW * s.sideMarginPct) / 100, 12), viewportW * 0.3);
    const padBlock = Math.min(Math.max((availableH * s.blockMarginPct) / 100, 0), availableH * 0.3);
    const padTop = chromeTop + padBlock;
    const padBottom = chromeBottom + padBlock;
    const contentW = Math.max(viewportW - 2 * padX, 1);
    const contentH = Math.max(viewportH - padTop - padBottom, 1);

    const content = this.doc.createElement("div");
    if (isImageOnly) content.className = "lumi-content lumi-image-only";
    else {
      let contentClass = allClasses ? `lumi-content ${allClasses}` : "lumi-content";
      if (s.forceTextColor) contentClass += " lumi-force-colors";
      if (this.settings.isFontOverride(activeFontId)) contentClass += " lumi-reader-font-override";
      if (s.readingDirection === "horizontal") {
        contentClass = `${contentClass.replace(WRITING_MODE_CLASS_RE, "")} hltr`;
      } else if (s.readingDirection === "vertical") {
        contentClass = `${contentClass.replace(WRITING_MODE_CLASS_RE, "")} vrtl`;
      }
      content.className = contentClass;
    }
    if (lang) content.setAttribute("lang", lang);
    // Render contract: tag the chapter root so anchors resolve node → spine character.
    content.dataset.lumiSpineIndex = String(this.store.getState().spineIndex);
    content.dataset.lumiSpineHref = section.href;

    // Inline so EPUB stylesheets can't override the page geometry.
    const cs = content.style;
    cs.overflow = "hidden";
    cs.width = `${viewportW}px`;
    cs.height = `${viewportH}px`;
    cs.padding = `${padTop}px ${padX}px ${padBottom}px`;
    cs.setProperty("--lumi-cw", `${contentW}px`);
    cs.setProperty("--lumi-ch", `${contentH}px`);
    cs.setProperty("--lumi-v-margin-cap", `${contentH * 0.18}px`);
    cs.setProperty("--reader-font-size", `${s.fontSizePx}px`);
    const fontCss = this.settings.fontCssValue(activeFontId);
    if (fontCss) cs.setProperty("--reader-font-family", fontCss);
    cs.setProperty("--reader-line-height", String(s.lineHeight));

    if (isImageOnly) {
      this.fixImageOnlySvgs(bodyEl, contentW, contentH);
      // Lift images out of wrapper paragraphs into the grid container; promote a nearest-ancestor id so
      // fragment anchors stay reachable. Skip 1x1 spacers.
      for (const el of bodyEl.querySelectorAll<HTMLElement>("img, svg")) {
        if (/(?:^|\s)keep-space/.test(el.getAttribute("class") ?? "")) continue;
        if (!el.id) {
          const idAncestor = el.parentElement?.closest("[id]");
          if (idAncestor) el.id = idAncestor.id;
        }
        content.appendChild(el);
      }
    } else {
      if (writingModeOverride) cs.writingMode = writingModeOverride;
      while (bodyEl.firstChild) content.appendChild(bodyEl.firstChild);
    }

    const spacer = this.doc.createElement("div");
    spacer.style.cssText = SPACER_CSS;
    content.appendChild(spacer);

    this.currentBaseDir = baseDir;
    // Reader-owned HOST + USER CSS is static, so adopt the shared constructable sheets (parsed once) when
    // supported; else fall back to per-render <style>. Publisher CSS is a shadow child either way; USER_CSS
    // is all !important so it wins over publisher rules regardless of adopted-vs-child cascade order.
    const epubStyleEl = cssParts.length > 0 ? this.el("style", cssParts.join("\n")) : null;
    if (READER_SHARED_SHEETS) {
      shadow.adoptedStyleSheets = READER_SHARED_SHEETS;
      shadow.replaceChildren(...(epubStyleEl ? [epubStyleEl] : []), content);
    } else {
      const extras = epubStyleEl ? [epubStyleEl] : [];
      shadow.replaceChildren(this.el("style", HOST_CSS), ...extras, this.el("style", USER_CSS), content);
    }

    if (!isImageOnly) {
      const actualVertical = getComputedStyle(content).writingMode.startsWith("vertical");
      const columnGap = actualVertical ? padTop + padBottom : padX * 2;
      const columnsPerPage = effectiveColumnsPerPage(s.pageColumns, actualVertical, viewportW, columnGap);
      const columnWidth = actualVertical ? contentH : viewportW / columnsPerPage - columnGap;
      cs.columnWidth = `${Math.max(columnWidth, 1)}px`;
      cs.columnGap = `${columnGap}px`;
      cs.columnFill = "auto";
    }

    // Measure overflow; extend a trailing spacer so pageCount * pageSize == scrollSize.
    const overflowX = Math.max(content.scrollWidth - content.clientWidth, 0);
    const overflowY = Math.max(content.scrollHeight - content.clientHeight, 0);
    const axis: "x" | "y" = overflowX >= overflowY ? "x" : "y";
    let nextScrollLeftSign: 1 | -1 = 1;
    if (axis === "x") {
      // RTL horizontal scroll sign varies by browser; detect after EPUB CSS applies.
      content.scrollLeft = 1;
      if (content.scrollLeft !== 1) {
        content.scrollLeft = -1;
        nextScrollLeftSign = content.scrollLeft < 0 ? -1 : 1;
      }
      content.scrollLeft = 0;
    }
    this.pageGeometry = { axis, scrollLeftSign: nextScrollLeftSign };
    this.contentEl = content;
    this.currentSection = section;

    const pageSize = Math.max(axis === "x" ? content.clientWidth : content.clientHeight, 1);
    const scrollSize = Math.max(axis === "x" ? content.scrollWidth : content.scrollHeight, pageSize);
    const pageCount = Math.max(Math.ceil(scrollSize / pageSize), 1);
    const trailing = pageCount * pageSize - scrollSize;
    if (trailing > 0) {
      const ts = spacer.style;
      if (axis === "x") {
        ts.left = `${scrollSize}px`;
        ts.width = `${trailing}px`;
        ts.height = "1px";
      } else {
        ts.top = `${scrollSize}px`;
        ts.width = "1px";
        ts.height = `${trailing}px`;
      }
    }

    // Map element id → page so anchors resolve and the chapter label can refine past `#fragment` nav entries.
    const fragmentPages = new Map<string, number>();
    for (const el of content.querySelectorAll<HTMLElement>("[id]")) {
      const offset = axis === "x" ? el.offsetLeft : el.offsetTop;
      const pageOffset = axis === "x" && nextScrollLeftSign < 0 ? Math.abs(offset) : offset;
      fragmentPages.set(el.id, Math.floor(pageOffset / pageSize));
    }

    const st = this.store.getState();
    const pendingFragment = st.pendingFragment;
    const pageInChapter =
      pendingFragment !== null
        ? (fragmentPages.get(pendingFragment) ?? 0)
        : fraction !== null
          ? Math.min(Math.floor(fraction * pageCount), pageCount - 1)
          : st.paginated.pendingPage === "last"
            ? pageCount - 1
            : 0;

    this.store.setPaginatedMetrics({
      fragmentPages,
      totalPagesInChapter: pageCount,
      pageInChapter,
      pendingPage: "first",
      lastRenderedHref: section.href,
    });
    this.store.clearPendingFragment();
    this.applyPageScroll(content, pageInChapter);

    this.notifyRender(book, section, content, isImageOnly, myToken);

    await this.applyPendingRestore();
  }

  private async renderSvgSpread(book: Book, rightSection: Section, leftSection: Section): Promise<void> {
    const myToken = ++this.renderToken;
    const epub = book.epub;
    const host = this.host;
    const shadow = this.shadow;
    if (!epub || !host || !shadow) return;

    const rootStyle = getComputedStyle(this.doc.documentElement);
    const chromeTop = PAD_TOP + (parseFloat(rootStyle.getPropertyValue("--sai-top")) || 0);
    const chromeBottom = PAD_BOTTOM + (parseFloat(rootStyle.getPropertyValue("--sai-bottom")) || 0);
    const viewportW = Math.max(host.clientWidth, 1);
    const viewportH = Math.max(host.clientHeight, 1);
    const contentH = Math.max(viewportH - chromeTop - chromeBottom, 1);

    const nextBlobUrls: string[] = [];
    const [left, right] = await Promise.all([
      this.buildSvgSpreadPage(epub.spine[leftSection.spineIndex], epub, nextBlobUrls),
      this.buildSvgSpreadPage(epub.spine[rightSection.spineIndex], epub, nextBlobUrls),
    ]);
    if (myToken !== this.renderToken) {
      for (const u of nextBlobUrls) URL.revokeObjectURL(u);
      return;
    }
    if (!left || !right) {
      for (const u of nextBlobUrls) URL.revokeObjectURL(u);
      await this.renderItem(book, rightSection, false);
      return;
    }

    const stage = this.doc.createElement("div");
    stage.className = "lumi-spread-stage";
    stage.style.padding = `${chromeTop}px 0 ${chromeBottom}px`;

    const spread = this.doc.createElement("div");
    spread.className = "lumi-svg-spread";
    spread.style.gridTemplateColumns = `${left.ratio}fr ${right.ratio}fr`;
    const spreadRatio = left.ratio + right.ratio;
    const spreadW = Math.max(Math.min(viewportW, contentH * spreadRatio), 1);
    const spreadH = Math.max(spreadW / spreadRatio, 1);
    spread.style.width = `${spreadW}px`;
    spread.style.height = `${spreadH}px`;
    spread.append(left.svg, right.svg);
    stage.appendChild(spread);

    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls.length = 0;
    this.blobUrls.push(...nextBlobUrls);

    // Adopt the shared HOST/USER sheets (USER rules target `.lumi-content`, absent here, so they're inert) and add the spread stylesheet as a child — reassigning `adoptedStyleSheets` also clears any from a prior `renderItem`.
    if (READER_SHARED_SHEETS) {
      shadow.adoptedStyleSheets = READER_SHARED_SHEETS;
      shadow.replaceChildren(this.el("style", SPREAD_CSS), stage);
    } else {
      shadow.replaceChildren(this.el("style", HOST_CSS), this.el("style", SPREAD_CSS), stage);
    }
    this.contentEl = undefined;
    this.currentSection = rightSection;
    this.pageGeometry = { axis: "y", scrollLeftSign: 1 };

    const fragmentPages = new Map<string, number>();
    for (const id of right.ids) fragmentPages.set(id, 0);
    for (const id of left.ids) fragmentPages.set(id, 0);
    this.store.setPaginatedMetrics({
      fragmentPages,
      totalPagesInChapter: 1,
      pageInChapter: 0,
      pendingPage: "first",
      lastRenderedHref: rightSection.href,
    });
    this.store.clearPendingFragment();
  }

  private async buildSvgSpreadPage(
    spineItem: SpineItem,
    epub: Epub,
    nextBlobUrls: string[],
  ): Promise<SvgSpreadPage | null> {
    const loaded = await loadSpineDocument(spineItem, epub);
    if (!loaded) return null;

    await rewriteResourceUrls(loaded.doc, epub, loaded.baseDir, nextBlobUrls);

    const svg = loaded.bodyEl.querySelector<SVGSVGElement>("svg");
    if (!svg) return null;
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.display = "block";

    const viewBox = svg.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
    const ratio = viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0 ? viewBox[2] / viewBox[3] : 1;
    const ids: string[] = [];
    for (const el of loaded.doc.querySelectorAll<HTMLElement>("[id]")) ids.push(el.id);
    return { svg, ratio, ids };
  }

  private fixImageOnlySvgs(bodyEl: HTMLElement, contentW: number, contentH: number): void {
    // Percent-sized <svg> collapses in indefinite-size containers; replace with explicit pixels from the viewBox.
    for (const svg of bodyEl.querySelectorAll("svg")) {
      const dims = (svg.getAttribute("width") ?? "") + (svg.getAttribute("height") ?? "");
      const vb = svg.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
      if (!dims.includes("%") || vb?.length !== 4 || !(vb[2] > 0 && vb[3] > 0)) continue;
      const ratio = vb[2] / vb[3];
      const [pw, ph] = contentW / ratio <= contentH ? [contentW, contentW / ratio] : [contentH * ratio, contentH];
      svg.setAttribute("width", String(Math.floor(pw)));
      svg.setAttribute("height", String(Math.floor(ph)));
    }
  }

  /** Scroll the mounted content to the store's current in-chapter page (the wrapper calls this when `paginated.pageInChapter` changes). */
  applyPage(): void {
    const content = this.contentEl;
    if (!content) return;
    const st = this.store.getState();
    this.applyPageScroll(content, st.paginated.pageInChapter);
    if (
      st.navigationSeq > 0 &&
      st.restore.status === "idle" &&
      this.currentSection?.href === st.paginated.lastRenderedHref
    ) {
      this.reportCurrentPosition();
    }
  }

  private applyPageScroll(el: HTMLElement, pageIndex: number): void {
    if (this.pageGeometry.axis === "x") {
      el.scrollLeft = this.pageGeometry.scrollLeftSign * pageIndex * el.clientWidth;
    } else {
      el.scrollTop = pageIndex * el.clientHeight;
    }
  }

  // Force-color toggle. `color` is repaint-only — it does not reflow, so pagination geometry is unchanged
  // and no re-measure is needed. Cheap path for the reader-theme text-color override (page/background
  // colors ride inherited CSS custom properties and need no engine call at all).
  applyTextColor(): void {
    const content = this.contentEl;
    if (!content || content.classList.contains("lumi-image-only")) return;
    content.classList.toggle("lumi-force-colors", this.settings.get().forceTextColor);
  }

  /** Land on the restore target's page within the current chapter. */
  async applyPendingRestore(): Promise<void> {
    const content = this.contentEl;
    if (!content) return;
    const st = this.store.getState();
    const restore = st.restore;
    if (restore.status !== "pending" || !restore.point || restore.point.locator.spineIndex !== st.spineIndex) return;

    if (content.classList.contains("lumi-image-only")) {
      this.store.setPaginatedMetrics({ pageInChapter: 0 });
      this.applyPageScroll(content, 0);
      this.store.setRestoreStatus("idle");
      return;
    }

    const token = this.renderToken;
    this.store.setRestoreStatus("applying");
    await nextFrame();
    if (token !== this.renderToken || content !== this.contentEl) return this.resetInterruptedRestore(restore.token);

    const page = this.pageForAtom(content, restore.point.locator.atomOffset);
    if (page === null) {
      this.store.setRestoreStatus("idle");
      return;
    }
    const total = this.store.getState().paginated.totalPagesInChapter;
    const target = Math.min(Math.max(page, 0), total - 1);
    this.store.setPaginatedMetrics({ pageInChapter: target });
    this.applyPageScroll(content, target);
    this.store.setRestoreStatus("settling");
    await nextFrame();
    if (token !== this.renderToken || content !== this.contentEl) return this.resetInterruptedRestore(restore.token);
    this.store.setRestoreStatus("idle");
  }

  private resetInterruptedRestore(token: number): void {
    if (this.store.getState().restore.token === token) this.store.setRestoreStatus("pending");
  }

  /** Snapshot the current scroll position as a `ReaderPosition`. */
  capturePosition(): ReaderPosition | null {
    const content = this.contentEl;
    const section = this.currentSection;
    const st = this.store.getState();
    if (!content || !section || !st.book) return null;

    if (content.classList.contains("lumi-image-only")) {
      return buildPosition(st.book, st.spineIndex, section.href, 0);
    }

    const units = collectAtomUnits(content);
    const pageSize = this.pageSizeFor(content);
    const pageIndex = Math.max(0, Math.round(this.currentPageOffset(content) / pageSize));
    const atom = this.atomAtPageTop(content, units, pageIndex, pageSize);
    return atom === null ? null : buildPosition(st.book, st.spineIndex, section.href, atom);
  }

  private reportCurrentPosition(): void {
    const st = this.store.getState();
    if (st.status !== "ready" || st.restore.status !== "idle") return;
    const position = this.capturePosition();
    if (position) this.store.reportPosition(position);
  }

  /** First atom that renders on `pageIndex` (the reading position at its top). */
  private atomAtPageTop(content: HTMLElement, units: AtomUnit[], pageIndex: number, pageSize: number): number | null {
    let best: number | null = units[0]?.atomStart ?? null;
    for (const unit of units) {
      const startPage = this.pageForAtomUnits(content, unit.atomStart, pageSize, units);
      if (startPage === null) continue;
      if (startPage >= pageIndex) return unit.atomStart;
      // A text node can span into this page; scan its atoms for the boundary.
      if (unit.kind === "text" && unit.atomEnd - unit.atomStart > 1) {
        const endPage = this.pageForAtomUnits(content, unit.atomEnd - 1, pageSize, units);
        if (endPage !== null && endPage >= pageIndex) {
          for (let a = unit.atomStart; a < unit.atomEnd; a++) {
            const p = this.pageForAtomUnits(content, a, pageSize, units);
            if (p !== null && p >= pageIndex) return a;
          }
        }
      }
      best = unit.atomStart;
    }
    return best;
  }

  private pageForAtom(content: HTMLElement, atom: number): number | null {
    return this.pageForAtomUnits(content, atom, this.pageSizeFor(content), collectAtomUnits(content));
  }

  private pageForAtomUnits(content: HTMLElement, atom: number, pageSize: number, units: AtomUnit[]): number | null {
    const offset = this.atomPageOffset(content, atom, units);
    return offset === null ? null : Math.floor(offset / pageSize);
  }

  /** Scroll-axis offset (px) of an atom's rendered rect from the content origin. */
  private atomPageOffset(content: HTMLElement, atom: number, units: AtomUnit[]): number | null {
    const rect = this.rectForAtom(content, atom, units);
    return rect ? this.rectPageOffset(content, rect) : null;
  }

  private rectForAtom(content: HTMLElement, atom: number, units: AtomUnit[]): DOMRect | null {
    const unit =
      units.find((u) => atom >= u.atomStart && atom < u.atomEnd) ??
      units.find((u) => u.atomStart >= atom) ??
      units.at(-1);
    if (!unit) return null;

    if (unit.kind === "replaced") {
      return usableRect(unit.node.getBoundingClientRect());
    }
    const point = atomToPoint(content, Math.max(unit.atomStart, Math.min(atom, unit.atomEnd - 1)), units);
    if (!point || point.node.nodeType !== TEXT_NODE) return null;
    const text = point.node.nodeValue ?? "";
    if (!text) return null;
    const range = this.doc.createRange();
    const start = Math.min(point.offset, Math.max(text.length - 1, 0));
    range.setStart(point.node, start);
    range.setEnd(point.node, Math.min(start + 1, text.length));
    const rect = firstUsableRect(range);
    range.detach();
    return rect;
  }

  private pageSizeFor(content: HTMLElement): number {
    return Math.max(this.pageGeometry.axis === "x" ? content.clientWidth : content.clientHeight, 1);
  }

  private currentPageOffset(content: HTMLElement): number {
    return this.pageGeometry.axis === "x" ? Math.abs(content.scrollLeft) : content.scrollTop;
  }

  private rectPageOffset(content: HTMLElement, rect: DOMRect): number {
    const contentRect = content.getBoundingClientRect();
    if (this.pageGeometry.axis === "x") {
      const scrollOffset = Math.abs(content.scrollLeft);
      const localOffset =
        this.pageGeometry.scrollLeftSign < 0 ? contentRect.right - rect.right : rect.left - contentRect.left;
      return scrollOffset + localOffset;
    }
    return content.scrollTop + rect.top - contentRect.top;
  }

  private notifyRender(
    book: Book,
    section: Section,
    content: HTMLElement,
    isImageOnly: boolean,
    token: number,
  ): void {
    if (this.extensions.length === 0) return;
    const ctx = this.makeRenderContext(book, section, content, isImageOnly, token);
    for (const ext of this.extensions) ext.onRender?.(ctx);
  }

  private makeRenderContext(
    book: Book,
    section: Section,
    content: HTMLElement,
    isImageOnly: boolean,
    token: number,
  ): RenderContext {
    let units: AtomUnit[] | null = null;
    return {
      shadow: this.shadow as ShadowRoot,
      content,
      book,
      section,
      spineIndex: this.store.getState().spineIndex,
      isImageOnly,
      atomUnits: () => (units ??= collectAtomUnits(content)),
      isCurrent: () => token === this.renderToken && content === this.contentEl,
    };
  }

  private readonly onShadowClick = (e: Event): void => {
    const target = e.target as Element | null;

    const anchor = target?.closest<HTMLAnchorElement>("a[href]");
    if (anchor) {
      this.handleAnchor(anchor, e);
      return;
    }

    if (this.extensions.length === 0) return;
    const content = this.contentEl;
    const section = this.currentSection;
    const book = this.store.getState().book;
    if (!content || !section || !book) return;

    const me = e as MouseEvent;
    const ctx: PointerContext = {
      ...this.makeRenderContext(book, section, content, content.classList.contains("lumi-image-only"), this.renderToken),
      clientX: me.clientX,
      clientY: me.clientY,
    };
    for (const ext of this.extensions) {
      if (ext.onPointerDown?.(ctx, e) === true) return;
    }
  };

  private handleAnchor(anchor: HTMLAnchorElement, e: Event): void {
    const raw = anchor.getAttribute("href");
    if (!raw) return;
    e.preventDefault();

    if (/^(?:https?|mailto|tel):/i.test(raw)) {
      window.open(raw, "_blank", "noopener,noreferrer");
      return;
    }

    const section = this.currentSection;
    if (raw.startsWith("#")) {
      if (section) this.store.jumpToHref(section.href, raw.slice(1));
      return;
    }

    const hashIdx = raw.indexOf("#");
    const path = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
    const fragment = hashIdx === -1 ? null : raw.slice(hashIdx + 1);
    const abs = resolveHref(this.currentBaseDir, path);
    if (abs) this.store.jumpToHref(abs, fragment);
  }

  private el(tag: "style", text: string): HTMLStyleElement {
    const node = this.doc.createElement(tag);
    node.textContent = text;
    return node;
  }
}

function effectiveColumnsPerPage(
  preferred: number,
  actualVertical: boolean,
  viewportW: number,
  columnGap: number,
): number {
  if (actualVertical || preferred < 2) return 1;
  const twoColumnWidth = viewportW / 2 - columnGap;
  return twoColumnWidth >= MIN_COLUMN_MAIN_SIZE_PX ? 2 : 1;
}

function firstUsableRect(range: Range): DOMRect | null {
  for (const rect of range.getClientRects()) {
    if (rect.width > 0 || rect.height > 0) return rect;
  }
  return usableRect(range.getBoundingClientRect());
}

function usableRect(rect: DOMRect): DOMRect | null {
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
