import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build output goes one directory up to the live `Orb/` folder that the
// WKWebView (NotchController.swift) loads. Static assets (vad/, vendor/,
// audio/) are copied verbatim by scripts/copy-static.mjs after build.
export default defineConfig({
  plugins: [react()],
  base: "./", // relative paths so file:// or http:// both work
  build: {
    outDir: "../Orb",
    emptyOutDir: false, // we keep vad/ + vendor/ + assets/audio/ from old tree
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Stable chunk names so the index.html references stay simple.
        entryFileNames: "assets/main-[hash].js",
        chunkFileNames: "assets/chunk-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    proxy: {
      // For local dev: dev server on 5173, router on 3340/3341. SSE + send go to router.
      "/api": "https://localhost:3341",
    },
  },
});
