# lumi-reader

Framework-agnostic EPUB reader engine, plus thin per-framework wrappers.

## Packages

| Package | What |
|---|---|
| `@lostcoords/lumi-epub` | Parse `.epub` → `Book` (atom-offset model). Zero deps, browser-first. |
| `@lostcoords/lumi-reader-core` | Paginated + continuous render engine, neutral store, ports. |
| `@lostcoords/lumi-reader-svelte` | Svelte 5 wrapper. |

## Use it (Svelte)

```svelte
<script>
  import { Reader } from "@lostcoords/lumi-reader-svelte";
  // store: createReaderStore({ ports }) from @lostcoords/lumi-reader-core
  // settings: your app's reactive SettingsPort
</script>

<Reader {store} {settings} />
```

`Reader` mounts the engine and forwards settings changes. The app owns the `store`
and drives navigation directly (`store.nextPage()`, `store.jumpToHref(...)`). Props
are captured at mount — to reset against a new store, remount with `{#key store}`.
For prop typechecking, import `@lostcoords/lumi-reader-svelte/Reader.svelte` directly.

## Develop

```sh
bun install
bun run test        # all packages
bun run typecheck
bun run build
```

## License

[MIT](LICENSE)
