import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReaderSettings, ReaderState, ReaderStore, SettingsPort } from "@lumi/reader-core";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Reader } from "../src/Reader";
import { useReaderStore } from "../src/useReaderStore";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

function makeStore() {
  let state = {
    status: "idle",
    book: null,
    flow: "paginated",
    spineIndex: 0,
    navigationSeq: 0,
    restore: { status: "idle", token: 0, point: null },
  } as ReaderState;
  const listeners = new Set<(state: ReaderState) => void>();
  const store = {
    getState: () => state,
    subscribe(listener: (state: ReaderState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as ReaderStore;

  return {
    store,
    listenerCount: () => listeners.size,
    set(patch: Partial<ReaderState>) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
  };
}

const settings = {
  get: () => ({ fontSizePx: 18 }) as ReaderSettings,
} as SettingsPort;

test("useReaderStore bails out when a composite selection is equal", async () => {
  const { store, set } = makeStore();
  const host = document.createElement("div");
  const root = createRoot(host);
  let renders = 0;

  function Status(): React.JSX.Element {
    const selected = useReaderStore(store, (state) => ({ status: state.status }), (a, b) => a.status === b.status);
    renders++;
    return <span>{selected.status}</span>;
  }

  await act(async () => root.render(<Status />));
  assert.equal(renders, 1);

  await act(async () => set({ bookId: "same-selection" }));
  assert.equal(renders, 1, "unrelated store updates do not render the component");

  await act(async () => set({ status: "loading" }));
  assert.equal(renders, 2);
  assert.equal(host.textContent, "loading");

  await act(async () => root.unmount());
});

test("Reader leaves one subscription after Strict Mode replay and none after unmount", async () => {
  const { store, listenerCount } = makeStore();
  const root = createRoot(document.createElement("div"));

  await act(async () =>
    root.render(
      <StrictMode>
        <Reader store={store} settings={settings} />
      </StrictMode>,
    ),
  );
  assert.equal(listenerCount(), 1);

  await act(async () => root.unmount());
  assert.equal(listenerCount(), 0);
});
