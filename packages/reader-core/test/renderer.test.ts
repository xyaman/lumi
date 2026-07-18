import "./helpers/dom.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Book, Epub, Resource, Section } from "@lostcoords/lumi-epub";
import {
  ContinuousRenderer,
  PaginatedRenderer,
  type ReaderState,
  type ReaderStore,
  type SettingsPort,
} from "../src/index.js";

const encoder = new TextEncoder();

function fixture(sectionCount: number, initialSpine = 0): { book: Book; store: ReaderStore; loads: number[] } {
  const resources = new Map<string, Resource>();
  const sections: Section[] = [];
  const loads: number[] = [];
  let atom = 0;
  for (let i = 0; i < sectionCount; i++) {
    const href = `OEBPS/c${i}.xhtml`;
    const text = `<html><body><p>section-${i}-text</p></body></html>`;
    const bytes = encoder.encode(text);
    resources.set(href, {
      href,
      mediaType: "application/xhtml+xml",
      size: bytes.length,
      load: async () => {
        loads.push(i);
        return bytes;
      },
    });
    sections.push({
      spineIndex: i,
      epubSpineIndex: i,
      href,
      startAtom: atom,
      endAtom: atom + 14,
      direction: null,
      forcedSide: null,
      layout: "reflowable",
      spreadPolicy: "auto",
      isImageOnly: false,
      ids: new Map(),
      cssHrefs: [],
      htmlClass: "",
      bodyClass: "",
    });
    atom += 14;
  }
  const epub: Epub = {
    meta: {
      title: "fixture",
      titles: ["fixture"],
      creator: [],
      language: "en",
      identifier: "fixture",
      identifiers: {},
      pageProgressionDirection: "ltr",
      layout: "reflowable",
      spread: "auto",
      epubVersion: "3.0",
    },
    manifest: new Map(),
    spine: [],
    nav: [],
    landmarks: [],
    resources,
    rootDir: "OEBPS",
    warnings: [],
  };
  const book: Book = {
    id: "fixture",
    epub,
    sections,
    chapters: [],
    pageProgressionDirection: "ltr",
    totalAtoms: atom,
    parsedAt: 0,
  };
  let state: ReaderState = {
    status: "ready",
    bookId: "fixture",
    book,
    error: null,
    flow: "continuous",
    spineIndex: initialSpine,
    pendingFragment: null,
    navigationSeq: 0,
    readingPoint: null,
    highlights: [],
    restore: { status: "idle", token: 0, point: null },
    paginated: {
      pageInChapter: 0,
      totalPagesInChapter: 1,
      pendingPage: "first",
      lastRenderedHref: undefined,
      fragmentPages: new Map(),
    },
    continuous: { scrollTop: 0, scrollRange: 1, viewportExtent: 0, spineOffsets: [], fragmentOffsets: [] },
  };
  const store = {
    getState: () => state,
    subscribe: () => () => {},
    loadBook: async () => {},
    setFlowMode: (flow) => {
      state = { ...state, flow };
    },
    nextPage: () => {},
    prevPage: () => {},
    nextChapter: () => {},
    prevChapter: () => {},
    jumpToPosition: () => {},
    jumpToNavEntry: (spineIndex, fragment) => {
      state = { ...state, spineIndex, pendingFragment: fragment };
    },
    jumpToHref: () => {},
    setPaginatedMetrics: (patch) => {
      state = { ...state, paginated: { ...state.paginated, ...patch } };
    },
    setContinuousMetrics: (patch) => {
      state = { ...state, continuous: { ...state.continuous, ...patch } };
    },
    setRestoreStatus: (status) => {
      state = { ...state, restore: { ...state.restore, status } };
    },
    reportPosition: (position) => {
      state = { ...state, readingPoint: position };
    },
    clearPendingFragment: () => {
      state = { ...state, pendingFragment: null };
    },
    setVisibleSpineIndex: (spineIndex) => {
      state = { ...state, spineIndex };
    },
    setHighlights: (highlights) => {
      state = { ...state, highlights };
    },
    activateHighlight: () => {},
    flushPosition: async () => {},
  } satisfies ReaderStore;
  return { book, store, loads };
}

const settings: SettingsPort = {
  get: () => ({
    readingDirection: "horizontal",
    fontSizePx: 16,
    lineHeight: 1.5,
    sideMarginPct: 5,
    blockMarginPct: 0,
    pageColumns: 1,
    publisherStyles: true,
    japaneseTokens: false,
    forceTextColor: false,
    fontId: "book",
  }),
  fontCssValue: () => null,
  isFontOverride: () => false,
  loadFont: async () => true,
  bookFontId: "book",
};

describe("renderer lifecycle", () => {
  it("keeps a bounded continuous spine window and removes it on destroy", async () => {
    const { store, loads } = fixture(20, 10);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const renderer = new ContinuousRenderer({ store, settings, doc: document, windowRadius: 2 });
    renderer.mount(host);
    await renderer.render();

    const shadow = host.firstElementChild?.shadowRoot;
    assert.ok(shadow);
    const mounted = [...shadow.querySelectorAll<HTMLElement>("section[data-lumi-spine-index]")].map((el) =>
      Number(el.dataset.lumiSpineIndex),
    );
    assert.deepEqual(mounted, [8, 9, 10, 11, 12]);
    assert.deepEqual(loads, [8, 9, 10, 11, 12]);
    assert.equal(shadow.querySelectorAll("[data-lumi-spacer]").length, 2);

    renderer.destroy();
    assert.equal(host.childElementCount, 0);
    host.remove();
  });

  it("can remount a paginated renderer on a host that already owns its shadow root", async () => {
    const { store } = fixture(1);
    store.setFlowMode("paginated");
    const host = document.createElement("div");
    document.body.appendChild(host);

    const first = new PaginatedRenderer({ store, settings, doc: document });
    first.mount(host);
    await first.render();
    first.destroy();

    const second = new PaginatedRenderer({ store, settings, doc: document });
    assert.doesNotThrow(() => second.mount(host));
    await second.render();
    assert.ok(host.shadowRoot?.querySelector(".lumi-content"));
    second.destroy();
    host.remove();
  });
});
