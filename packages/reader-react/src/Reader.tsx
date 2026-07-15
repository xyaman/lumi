// Thin React shell over `ReaderController`: owns the host element, mount/destroy,
// and the effect forwarding settings changes.

import type { Book, Section } from "@lumi/epub";
import type { ReaderExtension, ReaderStore, SettingsPort } from "@lumi/reader-core";
import { useEffect, useRef } from "react";
import { ReaderController } from "./controller";

export type ReaderProps = {
  store: ReaderStore;
  settings: SettingsPort;
  /** Bump on any settings change to trigger the forwarding effect (React can't auto-track `settings.get()`). */
  settingsVersion?: unknown;
  extensions?: ReaderExtension[];
  spreadPartnerFor?: (section: Section, book: Book) => Section | null;
  className?: string;
};

// Props are captured once at mount. Remount via `<Reader key={bookId} … />` to reset the engine.
export function Reader(props: ReaderProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ReaderController>(null);

  // Latest props for the once-only mount effect, without re-subscribing it.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const p = propsRef.current;
    const controller = new ReaderController({
      store: p.store,
      settings: p.settings,
      extensions: p.extensions,
      spreadPartnerFor: p.spreadPartnerFor,
    });
    controller.mount(host);
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inert until the first render lands (controller guards it).
  useEffect(() => {
    controllerRef.current?.applySettings(props.settings.get());
  }, [props.settings, props.settingsVersion]);

  return (
    <div
      ref={hostRef}
      className={props.className}
      data-lumi-reader
      style={{ position: "relative", width: "100%", height: "100%" }}
    />
  );
}
