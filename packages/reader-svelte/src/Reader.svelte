// Thin Svelte 5 shell over `ReaderController`. All orchestration lives in the
// framework-agnostic controller; this component owns the host element, the
// mount/destroy lifecycle, and the reactive effect that forwards settings changes.

import type { Book, Section } from "@lostcoords/lumi-epub";
import type { ReaderExtension, ReaderStore, SettingsPort } from "@lostcoords/lumi-reader-core";
import { onMount } from "svelte";
import { ReaderController } from "./controller";

type Props = {
  store: ReaderStore;
  settings: SettingsPort;
  extensions?: ReaderExtension[];
  spreadPartnerFor?: (section: Section, book: Book) => Section | null;
  class?: string;
};

// All props are captured once at mount. `store` content changes flow in through the controller's own
// subscription; `settings` changes flow through the effect below. To reset the engine against a
// different store/settings, remount the component (`{#key store}<Reader ... />{/key}`) — this
// deliberately does NOT tear down and rebuild on prop-identity churn (e.g. an inline `extensions`
// array), which an `$effect` here would.
let { store, settings, extensions, spreadPartnerFor, class: className }: Props = $props();

let host: HTMLDivElement | undefined = $state();
let controller: ReaderController | undefined;

onMount(() => {
  if (!host) return;
  const c = new ReaderController({ store, settings, extensions, spreadPartnerFor });
  c.mount(host);
  controller = c;
  return () => {
    c.destroy();
    controller = undefined;
  };
});

// `settings.get()` reads the app's reactive preferences, so this effect re-runs on any settings change and the controller diffs the snapshot. Read it unconditionally (not behind `controller?`) so the reactive dependency is always registered — optional chaining would skip the call on the first run before mount.
$effect(() => {
  const snapshot = settings.get();
  controller?.applySettings(snapshot);
});
</script>

<div bind:this={host} class={className} data-lumi-reader style="position:relative;width:100%;height:100%"></div>
