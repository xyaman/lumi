// The injected dependency boundary. The host app implements these; the engine
// calls them. This is the ONLY seam through which reader-core touches storage,
// network, or app settings — it never imports from the app.

import type { Book, Section } from "@lostcoords/lumi-epub";
import type { AtomUnit } from "./atomMap";
import type { ReaderPosition, TokenChip } from "./types";

/** Persistence. The app backs this with IndexedDB (and its own cloud sync); the engine parses the raw bytes itself. */
export type StoragePort = {
  /** Raw EPUB bytes. */
  loadBookFile(bookId: string): Promise<Blob | undefined>;
  /** Last saved location, or `null` if none. */
  getPosition(bookId: string): Promise<ReaderPosition | null>;
  /** Persist a new position. The caller debounces these. */
  setPosition(bookId: string, position: ReaderPosition): void | Promise<void>;
};

/** Japanese tokenization. Optional — absent when the feature is off or unauthenticated. */
export type TokenizerPort = (text: string) => Promise<TokenChip[]>;

/** Reader display settings the renderer reads at each render. Plain snapshot; the framework wrapper decides when a change should trigger a re-render. */
export type ReaderSettings = {
  /** `auto` defers to the section's writing-mode hints / EPUB CSS. */
  readingDirection: "auto" | "horizontal" | "vertical";
  fontSizePx: number;
  lineHeight: number;
  /** % of viewport width per side. */
  sideMarginPct: number;
  /** % of available height, top and bottom. */
  blockMarginPct: number;
  /** Preferred columns per page (clamped by min column size). */
  pageColumns: number;
  /** Apply the EPUB's own stylesheets. */
  publisherStyles: boolean;
  /** Gate for tokenization. */
  japaneseTokens: boolean;
  /** Reader theme overrides publisher text colors. */
  forceTextColor: boolean;
  /** Reader font selection. */
  fontId: string;
};

/** Reader settings + font resolution. Font handling lives here because the renderer only needs the resolved font-family CSS value and a load step; persisting custom fonts is a distinct host/storage concern. */
export type SettingsPort = {
  get(): ReaderSettings;
  /** Resolved CSS `font-family` value for `fontId`, or `null` to keep the publisher font. */
  fontCssValue(fontId: string): string | null;
  /** Whether `fontId` forces its family over the publisher's (adds the `.lumi-reader-font-override` class). */
  isFontOverride(fontId: string): boolean;
  /** Ensure the font is available; resolves `false` when it can't load so the renderer falls back to `bookFontId`. */
  loadFont(fontId: string): Promise<boolean>;
  /** Fallback font id when the requested one is unavailable. */
  bookFontId: string;
  /** The renderer chose a fallback; the host may persist this so the UI reflects the effective selection. */
  onFontFallback?(fontId: string): void;
};

/** Raw render surface an extension operates on (extensions all build on these primitives instead of engine-baked feature-specific hooks). */
export type RenderContext = {
  shadow: ShadowRoot;
  /** The `.lumi-content` root for the mounted section. */
  content: HTMLElement;
  book: Book;
  section: Section;
  /** Flow index into `book.sections`. */
  spineIndex: number;
  isImageOnly: boolean;
  /** Memoized atom walk of `content` by the parser's rules — extensions map DOM points ⇄ section-local atom offsets without re-implementing the walk. */
  atomUnits(): AtomUnit[];
  /** False once a newer render or teardown has superseded this context; an extension doing async work should bail when this returns false. */
  isCurrent(): boolean;
};

/** A pointer landed in the content. */
export type PointerContext = RenderContext & { clientX: number; clientY: number };

/** Consumer-supplied extension. Every method is optional; the renderer invokes them at fixed lifecycle points. */
export type ReaderExtension = {
  name?: string;
  /** Shadow root attached (once on mount) or detached (`null` on destroy). */
  onShadow?(shadow: ShadowRoot | null): void;
  /** Content rendered and measured — fires on every render/relayout with the fresh context. Repaint/stash `ctx` for later data-driven repaints. */
  onRender?(ctx: RenderContext): void;
  /** A pointer landed in the content. Runs after core internal-link handling and before the core default. Return `true` to consume it. */
  onPointerDown?(ctx: PointerContext, event: Event): boolean | void;
  /** Continuous reader scrolled (rAF-throttled). No-op for the paginated renderer. Viewport-relative work (lazy tokenization, on-demand repaint) lives here; the scroll container is `shadow.host`. */
  onScroll?(shadow: ShadowRoot): void;
  /** Renderer teardown — release observers/subscriptions here. */
  onDestroy?(): void;
};

/** One-way notifications from the engine to the host. */
export type ReaderCallbacks = {
  onPositionChange?(position: ReaderPosition): void;
  onProgress?(fraction: number): void;
  /** A painted highlight/mark was activated (tapped). Carries the host's span id. */
  onHighlightActivate?(id: string): void;
  /** A book finished parsing and is now the active book. */
  onBookOpened?(bookId: string): void;
  /** The previously-active book was left (switching books). The host flushes pending sync and clears per-book caches here. */
  onBookClosed?(previousBookId: string): void;
};

/** Aggregated ports. */
export type ReaderPorts = {
  storage: StoragePort;
  tokenizer?: TokenizerPort;
  isAuthenticated?(): boolean;
  callbacks?: ReaderCallbacks;
};
