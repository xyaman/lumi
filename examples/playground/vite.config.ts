import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Alias @lostcoords/lumi-epub to its TypeScript source so edits show up without a rebuild.
export default defineConfig({
  resolve: {
    alias: {
      "@lostcoords/lumi-epub": fileURLToPath(new URL("../../packages/epub/src/index.ts", import.meta.url)),
    },
  },
});
