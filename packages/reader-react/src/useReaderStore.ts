// React bridge to the neutral store: re-renders only when the selected slice changes.

import type { ReaderState, ReaderStore } from "@lumi/reader-core";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";

/** Subscribe to a state slice. Composite selections can provide a shallow or domain-specific equality check. */
export function useReaderStore<T>(
  store: ReaderStore,
  selector: (state: ReaderState) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useSyncExternalStoreWithSelector(
    store.subscribe,
    store.getState,
    store.getState,
    selector,
    isEqual,
  );
}
