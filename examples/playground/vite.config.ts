import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Alias @lumi/epub to its TypeScript source so edits show up without a rebuild.
export default defineConfig({
  resolve: {
    alias: {
      "@lumi/epub": fileURLToPath(new URL("../../packages/epub/src/index.ts", import.meta.url)),
    },
  },
});
