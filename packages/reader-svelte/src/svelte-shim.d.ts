// Minimal ambient declaration so `tsc` can resolve the `*.svelte` import in index.ts.
// The real prop types are checked by the consuming app's Svelte tooling (svelte-check);
// this package intentionally does not run the Svelte compiler.
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<Record<string, unknown>>;
  export default component;
}
