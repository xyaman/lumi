// Unit tests for ReaderController's store-delta → renderer-method routing, its
// microtask coalescing, and the settings cost-tier diffing. Renderers, the store,
// and the DOM are faked (the controller injects `createRenderer` and `doc`), so
// these run under plain tsx with no DOM — they exercise the orchestration logic,
// not real rendering.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Book } from "@lostcoords/lumi-epub";
import type { ReaderSettings, ReaderState, ReaderStore } from "@lostcoords/lumi-reader-core";
import { type CreateRenderer, ReaderController, type ReaderRenderer } from "../src/controller";

// ── fakes ─────────────────────────────────────────────────────────────────────

type FakeRenderer = ReaderRenderer & { calls: string[] };

function makeRenderer(): FakeRenderer {
  const calls: string[] = [];
  return {
    calls,
    mount() {
      calls.push("mount");
    },
    destroy() {
      calls.push("destroy");
    },
    async render(opts) {
      calls.push(opts?.preservePosition ? "render:preserve" : "render");
    },
    applyPage() {
      calls.push("applyPage");
    },
    async applyPendingRestore() {
      calls.push("applyPendingRestore");
    },
    applyTextColor() {
      calls.push("applyTextColor");
    },
    scheduleLayoutRefresh() {
      calls.push("scheduleLayoutRefresh");
    },
    scrollToCurrentTarget() {
      calls.push("scrollToCurrentTarget");
    },
  };
}

type FakeStore = {
  store: ReaderStore;
  set(patch: Partial<ReaderState>): void;
};

function makeStore(initial: ReaderState): FakeStore {
  let state = initial;
  const listeners = new Set<(s: ReaderState) => void>();
  const store = {
    getState: () => state,
    subscribe(l: (s: ReaderState) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as ReaderStore;
  return {
    store,
    set(patch) {
      state = { ...state, ...patch };
      for (const l of listeners) l(state);
    },
  };
}

const fakeHost = { appendChild() {} } as unknown as HTMLElement;
const fakeDoc = {
  createElement: () => ({ style: {}, remove() {} }),
} as unknown as Document;

const book = {} as Book;

function baseState(overrides: Partial<ReaderState> = {}): ReaderState {
  return {
    status: "idle",
    bookId: null,
    book: null,
    error: null,
    flow: "paginated",
    spineIndex: 0,
    pendingFragment: null,
    navigationSeq: 0,
    readingPoint: null,
    restore: { status: "idle", token: 0, point: null },
    paginated: {
      pageInChapter: 0,
      totalPagesInChapter: 1,
      pendingPage: "first",
      lastRenderedHref: undefined,
      fragmentPages: new Map(),
    },
    continuous: { scrollTop: 0, scrollRange: 1, viewportExtent: 0, spineOffsets: [], fragmentOffsets: [] },
    ...overrides,
  };
}

const SETTINGS: ReaderSettings = {
  readingDirection: "auto",
  fontSizePx: 18,
  lineHeight: 1.6,
  sideMarginPct: 6,
  blockMarginPct: 4,
  pageColumns: 1,
  publisherStyles: true,
  japaneseTokens: false,
  forceTextColor: false,
  fontId: "serif",
};

// Drain microtasks (schedule() and the async render()/started flip settle here).
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

type Harness = {
  controller: ReaderController;
  set: FakeStore["set"];
  created: { flow: string; renderer: FakeRenderer }[];
};

function harness(initial: ReaderState): Harness {
  const { store, set } = makeStore(initial);
  const created: { flow: string; renderer: FakeRenderer }[] = [];
  const createRenderer: CreateRenderer = (flow) => {
    const renderer = makeRenderer();
    created.push({ flow, renderer });
    return renderer;
  };
  const controller = new ReaderController({
    store,
    settings: { get: () => SETTINGS } as never,
    doc: fakeDoc,
    createRenderer,
  });
  controller.mount(fakeHost);
  return { controller, set, created };
}

const renderCount = (r: FakeRenderer) => r.calls.filter((c) => c.startsWith("render")).length;

// ── tests ───────────────────────────────────────────────────────────────────

test("coalesces multiple synchronous store emits into one render", async () => {
  // Mount into idle so no renderer exists yet, then emit ready+book and a queued
  // restore in the same tick — the way loadBook fans out two set() calls.
  const { set, created } = harness(baseState());
  set({ status: "ready", book });
  set({ restore: { status: "pending", token: 1, point: null } });
  await flush();

  assert.equal(created.length, 1, "one renderer created");
  assert.equal(created[0].flow, "paginated");
  assert.equal(renderCount(created[0].renderer), 1, "rendered exactly once, not per emit");
});

test("paginated: navigationSeq bump within a chapter turns the page (no re-render)", async () => {
  const { set, created } = harness(baseState({ status: "ready", book }));
  await flush();
  const r = created[0].renderer;
  assert.equal(renderCount(r), 1, "initial render");

  set({ navigationSeq: 1 }); // same spineIndex → page turn
  await flush();
  assert.ok(r.calls.includes("applyPage"), "turned the page");
  assert.equal(renderCount(r), 1, "did not re-render for a page turn");
});

test("paginated: spineIndex change re-renders the chapter", async () => {
  const { set, created } = harness(baseState({ status: "ready", book }));
  await flush();
  const r = created[0].renderer;

  set({ spineIndex: 1, navigationSeq: 1 });
  await flush();
  assert.equal(renderCount(r), 2, "re-rendered on chapter change");
  assert.ok(!r.calls.includes("applyPage"), "did not treat a chapter change as a page turn");
});

test("continuous: navigationSeq bump seeks instead of rendering", async () => {
  const { set, created } = harness(baseState({ status: "ready", book, flow: "continuous" }));
  await flush();
  const r = created[0].renderer;
  assert.equal(created[0].flow, "continuous");

  set({ navigationSeq: 1 });
  await flush();
  assert.ok(r.calls.includes("scrollToCurrentTarget"), "seeked to target");
  assert.equal(renderCount(r), 1, "did not re-render");
});

test("continuous: passive spineIndex change (scroll) does nothing", async () => {
  const { set, created } = harness(baseState({ status: "ready", book, flow: "continuous" }));
  await flush();
  const r = created[0].renderer;
  const before = [...r.calls];

  set({ spineIndex: 3 }); // scroll reported a new visible section, no nav
  await flush();
  assert.deepEqual(r.calls, before, "no renderer call on passive scroll");
});

test("flow switch tears down the old renderer and renders a fresh one", async () => {
  const { set, created } = harness(baseState({ status: "ready", book }));
  await flush();

  set({ flow: "continuous" });
  await flush();

  assert.equal(created.length, 2, "second renderer created for the new flow");
  assert.equal(created[1].flow, "continuous");
  assert.ok(created[0].renderer.calls.includes("destroy"), "old renderer destroyed");
  assert.equal(renderCount(created[1].renderer), 1, "new renderer rendered");
});

test("restore within the current chapter applies the pending restore", async () => {
  const { set, created } = harness(baseState({ status: "ready", book }));
  await flush();
  const r = created[0].renderer;

  // Same spineIndex, same navigationSeq, new restore token → restore in place.
  set({ restore: { status: "pending", token: 1, point: null } });
  await flush();
  assert.ok(r.calls.includes("applyPendingRestore"), "applied the queued restore");
  assert.equal(renderCount(r), 1, "restore in place did not re-render");
});

test("applySettings: color-only change repaints without reflow (paginated)", async () => {
  const { controller, created } = harness(baseState({ status: "ready", book }));
  await flush();
  const r = created[0].renderer;

  controller.applySettings(SETTINGS); // first call primes lastSettings, inert
  controller.applySettings({ ...SETTINGS, forceTextColor: true });
  assert.ok(r.calls.includes("applyTextColor"), "flipped color");
  assert.equal(renderCount(r), 1, "no reflow for a color change");
});

test("applySettings: geometry change reflows position-preserving (paginated)", async () => {
  const { controller, created } = harness(baseState({ status: "ready", book }));
  await flush();
  const r = created[0].renderer;

  controller.applySettings(SETTINGS);
  controller.applySettings({ ...SETTINGS, fontSizePx: 22 });
  assert.ok(r.calls.includes("render:preserve"), "reflowed while preserving position");
});

test("applySettings: geometry change refreshes layout in place (continuous)", async () => {
  const { controller, created } = harness(baseState({ status: "ready", book, flow: "continuous" }));
  await flush();
  const r = created[0].renderer;

  controller.applySettings(SETTINGS);
  controller.applySettings({ ...SETTINGS, lineHeight: 2.0 });
  assert.ok(r.calls.includes("scheduleLayoutRefresh"), "refreshed layout in place");
  assert.equal(renderCount(r), 1, "no full re-render");
});

test("applySettings: publisher-styles toggle forces a full rebuild", async () => {
  const { controller, created } = harness(baseState({ status: "ready", book }));
  await flush();
  const r = created[0].renderer;

  controller.applySettings(SETTINGS);
  controller.applySettings({ ...SETTINGS, publisherStyles: false });
  assert.equal(renderCount(r), 2, "rebuilt on CSS-source change");
});

test("applySettings is inert before the first render lands", async () => {
  // Mount into idle: no renderer, nothing started. A settings change must not throw
  // or render anything.
  const { controller, created } = harness(baseState());
  controller.applySettings(SETTINGS);
  controller.applySettings({ ...SETTINGS, fontSizePx: 30 });
  assert.equal(created.length, 0, "no renderer, no render");
});

test("applySettings reconciles a change queued during the initial render", async () => {
  const { store } = makeStore(baseState({ status: "ready", book }));
  const renderer = makeRenderer();
  let finishInitial!: () => void;
  let renders = 0;
  renderer.render = async (opts) => {
    renderer.calls.push(opts?.preservePosition ? "render:preserve" : "render");
    if (++renders === 1) await new Promise<void>((resolve) => (finishInitial = resolve));
  };

  const controller = new ReaderController({
    store,
    settings: { get: () => SETTINGS } as never,
    doc: fakeDoc,
    createRenderer: () => renderer,
  });
  controller.mount(fakeHost);
  controller.applySettings(SETTINGS);
  controller.applySettings({ ...SETTINGS, fontSizePx: 24 });

  assert.equal(renderCount(renderer), 1, "did not race the initial render");
  finishInitial();
  await flush();
  assert.equal(renderCount(renderer), 2, "applied the queued settings after render");
  assert.ok(renderer.calls.includes("render:preserve"), "preserved position during the deferred reflow");
});

test("a replaced renderer cannot mark the current renderer as ready", async () => {
  const { store, set } = makeStore(baseState({ status: "ready", book }));
  const created: FakeRenderer[] = [];
  const finishes: (() => void)[] = [];
  const createRenderer: CreateRenderer = () => {
    const renderer = makeRenderer();
    renderer.render = async (opts) => {
      renderer.calls.push(opts?.preservePosition ? "render:preserve" : "render");
      await new Promise<void>((resolve) => finishes.push(resolve));
    };
    created.push(renderer);
    return renderer;
  };
  const controller = new ReaderController({
    store,
    settings: { get: () => SETTINGS } as never,
    doc: fakeDoc,
    createRenderer,
  });

  controller.mount(fakeHost);
  controller.applySettings(SETTINGS);
  set({ flow: "continuous" });
  await flush();
  assert.equal(created.length, 2, "switched renderers");

  finishes[0]();
  await flush();
  controller.applySettings({ ...SETTINGS, lineHeight: 2 });
  assert.ok(!created[1].calls.includes("scheduleLayoutRefresh"), "kept settings queued while current render is pending");

  finishes[1]();
  await flush();
  assert.ok(created[1].calls.includes("scheduleLayoutRefresh"), "applied settings when the current render landed");
});
