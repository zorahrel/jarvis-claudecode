// Post-build steps:
//   1. Rename index.html → notch.html so the Swift WKWebView (which loads
//      `notch.html` via NotchController.swift) picks up the React build.
//   2. Optionally copy public assets that MUST persist across builds
//      (Silero VAD model, audio backgrounds) — we keep emptyOutDir=false
//      in vite.config so vad/ + vendor/ + audio/ are preserved.
import { rename, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORB_DIR = resolve(__dirname, "../../Orb");

const indexHtml = resolve(ORB_DIR, "index.html");
const notchHtml = resolve(ORB_DIR, "notch.html");

if (existsSync(indexHtml)) {
  if (existsSync(notchHtml)) {
    await rm(notchHtml);
  }
  await rename(indexHtml, notchHtml);
  console.log(`[copy-static] index.html → notch.html`);
} else {
  console.log(`[copy-static] no index.html in ${ORB_DIR}, skipping rename`);
}

const SRC_PUBLIC = resolve(__dirname, "../public-assets");
if (existsSync(SRC_PUBLIC)) {
  await cp(SRC_PUBLIC, ORB_DIR, { recursive: true });
  console.log(`[copy-static] public-assets/ → ${ORB_DIR}`);
}
