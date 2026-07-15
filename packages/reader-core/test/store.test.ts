// The neutral store state machine: load → navigate → restore, driven headless
// with a synthetic epub and in-memory storage port.

// The store's loadBook runs the full epub parser, which needs a faithful XML DOM.
// happy-dom's namespace handling isn't faithful enough (it drops container.xml's
// rootfile attribute), so use the epub package's @xmldom polyfill here. node:test
// runs each test file in its own process, so this doesn't clash with the happy-dom
// global used by atomMap.test.ts.
import "../../epub/test/helpers/dom.js";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { makeEpub, xhtml } from "../../epub/test/helpers/make-epub.js";
import { createReaderStore, type ReaderPosition, type ReaderStore, type StoragePort } from "../src/index.js";

// A 3-section epub: 5 atoms each.
function threeSectionEpub(): Blob {
  return makeEpub({
    files: {
      "c1.xhtml": xhtml("<p>あいうえお</p>"),
      "c2.xhtml": xhtml("<p>かきくけこ</p>"),
      "c3.xhtml": xhtml("<p>さしすせそ</p>"),
    },
    manifest: [
      { id: "c1", href: "c1.xhtml", mediaType: "application/xhtml+xml" },
      { id: "c2", href: "c2.xhtml", mediaType: "application/xhtml+xml" },
      { id: "c3", href: "c3.xhtml", mediaType: "application/xhtml+xml" },
    ],
    spine: [{ idref: "c1" }, { idref: "c2" }, { idref: "c3" }],
  });
}

function memoryStorage(blob: Blob, saved: ReaderPosition | null = null): StoragePort {
  return {
    loadBookFile: async () => blob,
    getPosition: async () => saved,
    setPosition: () => {},
  };
}

async function loadedStore(saved: ReaderPosition | null = null): Promise<ReaderStore> {
  const store = createReaderStore({ ports: { storage: memoryStorage(threeSectionEpub(), saved) } });
  await store.loadBook("book-1");
  return store;
}

describe("createReaderStore — load", () => {
  it("parses the book and becomes ready", async () => {
    const store = await loadedStore();
    const s = store.getState();
    assert.equal(s.status, "ready");
    assert.equal(s.bookId, "book-1");
    assert.equal(s.book?.sections.length, 3);
    assert.equal(s.book?.totalAtoms, 15);
    assert.equal(s.spineIndex, 0);
  });

  it("reports an error for a missing book file", async () => {
    const store = createReaderStore({
      ports: { storage: { loadBookFile: async () => undefined, getPosition: async () => null, setPosition: () => {} } },
    });
    await store.loadBook("missing");
    assert.equal(store.getState().status, "error");
    assert.match(store.getState().error ?? "", /not found/);
  });

  it("fires onBookOpened and onBookClosed", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const store = createReaderStore({
      ports: {
        storage: memoryStorage(threeSectionEpub()),
        callbacks: { onBookOpened: (id) => opened.push(id), onBookClosed: (id) => closed.push(id) },
      },
    });
    await store.loadBook("a");
    await store.loadBook("b");
    assert.deepEqual(opened, ["a", "b"]);
    assert.deepEqual(closed, ["a"]);
  });
});

describe("createReaderStore — navigation", () => {
  it("advances pages within a chapter, then rolls to the next chapter", async () => {
    const store = await loadedStore();
    store.setPaginatedMetrics({ totalPagesInChapter: 3 });
    store.nextPage();
    assert.equal(store.getState().paginated.pageInChapter, 1);
    store.nextPage();
    assert.equal(store.getState().paginated.pageInChapter, 2);
    // At the last page: nextPage rolls to the next chapter.
    store.nextPage();
    assert.equal(store.getState().spineIndex, 1);
    assert.equal(store.getState().paginated.pendingPage, "first");
  });

  it("prevPage at page 0 steps back a chapter landing on 'last'", async () => {
    const store = await loadedStore();
    store.jumpToNavEntry(2, null); // go to chapter index 2
    assert.equal(store.getState().spineIndex, 2);
    store.prevPage();
    assert.equal(store.getState().spineIndex, 1);
    assert.equal(store.getState().paginated.pendingPage, "last");
  });

  it("does not advance past the last/first chapter", async () => {
    const store = await loadedStore();
    store.jumpToNavEntry(2, null);
    store.nextChapter();
    assert.equal(store.getState().spineIndex, 2); // clamped
    store.jumpToNavEntry(0, null);
    store.prevChapter();
    assert.equal(store.getState().spineIndex, 0); // clamped
  });

  it("bumps navigationSeq on each navigation", async () => {
    const store = await loadedStore();
    const before = store.getState().navigationSeq;
    store.nextChapter();
    assert.ok(store.getState().navigationSeq > before);
  });
});

describe("createReaderStore — restore", () => {
  let savedHref: string;
  before(async () => {
    // Discover the resolved href of the 2nd section for a saved position.
    const store = await loadedStore();
    savedHref = store.getState().book!.sections[1].href;
  });

  it("queues a saved position as a pending restore", async () => {
    const progress: number[] = [];
    const saved: ReaderPosition = {
      version: 1,
      locator: { spineIndex: 1, spineHref: savedHref, atomOffset: 3 },
      progress: { globalAtomOffset: 8, totalAtoms: 15, fraction: 8 / 15 },
    };
    const store = createReaderStore({
      ports: {
        storage: memoryStorage(threeSectionEpub(), saved),
        callbacks: { onProgress: (f) => progress.push(f) },
      },
    });
    await store.loadBook("book-1");
    const s = store.getState();
    assert.equal(s.restore.status, "pending");
    assert.equal(s.spineIndex, 1);
    assert.equal(s.readingPoint?.locator.atomOffset, 3);
    assert.ok(progress.length > 0);
  });

  it("re-resolves the flow index by href when the index drifts", async () => {
    // Saved spineIndex is wrong (5), but href points at section 1 → resolves to 1.
    const saved: ReaderPosition = {
      version: 1,
      locator: { spineIndex: 5, spineHref: savedHref, atomOffset: 2 },
      progress: { globalAtomOffset: 0, totalAtoms: 15, fraction: 0 },
    };
    const store = createReaderStore({ ports: { storage: memoryStorage(threeSectionEpub(), saved) } });
    await store.loadBook("book-1");
    assert.equal(store.getState().spineIndex, 1);
  });

  it("advances the restore sub-machine via setRestoreStatus", async () => {
    const store = await loadedStore();
    store.jumpToNavEntry(1, null);
    store.jumpToPosition({
      version: 1,
      locator: { spineIndex: 0, spineHref: store.getState().book!.sections[0].href, atomOffset: 0 },
      progress: { globalAtomOffset: 0, totalAtoms: 15, fraction: 0 },
    });
    assert.equal(store.getState().restore.status, "pending");
    store.setRestoreStatus("applying");
    assert.equal(store.getState().restore.status, "applying");
    store.setRestoreStatus("idle");
    assert.equal(store.getState().restore.status, "idle");
  });
});

describe("createReaderStore — reportPosition", () => {
  it("updates readingPoint and notifies the host without bumping navigationSeq", async () => {
    const changes: ReaderPosition[] = [];
    const progress: number[] = [];
    const store = createReaderStore({
      ports: {
        storage: memoryStorage(threeSectionEpub()),
        callbacks: { onPositionChange: (p) => changes.push(p), onProgress: (f) => progress.push(f) },
      },
    });
    await store.loadBook("book-1");
    const seq = store.getState().navigationSeq;

    const point: ReaderPosition = {
      version: 1,
      locator: { spineIndex: 1, spineHref: store.getState().book!.sections[1].href, atomOffset: 2 },
      progress: { globalAtomOffset: 7, totalAtoms: 15, fraction: 7 / 15 },
    };
    store.reportPosition(point);

    const s = store.getState();
    assert.equal(s.readingPoint?.locator.atomOffset, 2);
    assert.equal(s.navigationSeq, seq); // a live read is not a navigation
    assert.deepEqual(changes.at(-1), point);
    assert.equal(progress.at(-1), 7 / 15);
  });
});

describe("createReaderStore — subscribe & flow", () => {
  it("notifies subscribers on state change", async () => {
    const store = await loadedStore();
    let calls = 0;
    const unsub = store.subscribe(() => calls++);
    store.setPaginatedMetrics({ totalPagesInChapter: 2 });
    store.nextPage();
    assert.ok(calls >= 2);
    unsub();
    const frozen = calls;
    store.nextChapter();
    assert.equal(calls, frozen); // no longer notified
  });

  it("uses the continuous-target path when flow is continuous", async () => {
    const store = await loadedStore();
    store.setFlowMode("continuous");
    store.jumpToNavEntry(2, "frag-1");
    const s = store.getState();
    assert.equal(s.spineIndex, 2);
    assert.equal(s.pendingFragment, "frag-1");
  });
});
