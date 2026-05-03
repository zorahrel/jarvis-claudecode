/**
 * Inject the legacy external bundles at runtime — bypassing Vite's
 * build-time resolution. The bundles live alongside the React build
 * inside Orb/assets/ and are loaded relative to window.location.
 *
 * Order matters slightly:
 *   - vad-controller.js can load anytime (defines window.jarvisVAD).
 *   - audio-aura.js depends on the DOM (#three-container) being present;
 *     we inject it once React has rendered the App tree.
 *   - notch-BpndmdBM.js (Three.js orb bundle) idem.
 */
import { useEffect } from "react";

interface AssetSpec {
  src: string;
  type?: "module" | "classic";
  /** CSS instead of JS. */
  css?: boolean;
}

const ASSETS: AssetSpec[] = [
  { src: "./assets/three-CnkMWE36.css", css: true },
  { src: "./assets/vad-controller.js", type: "module" },
  { src: "./assets/audio-aura.js", type: "classic" },
  { src: "./assets/notch-BpndmdBM.js", type: "module" },
];

export function useExternalAssets(): void {
  useEffect(() => {
    // De-dup: don't reinject if React HMR re-runs the effect.
    const flagKey = "__jarvisExternalAssetsLoaded";
    if ((window as any)[flagKey]) return;
    (window as any)[flagKey] = true;

    for (const a of ASSETS) {
      if (a.css) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.crossOrigin = "anonymous";
        link.href = a.src;
        document.head.appendChild(link);
      } else {
        const script = document.createElement("script");
        if (a.type === "module") script.type = "module";
        script.crossOrigin = "anonymous";
        script.src = a.src;
        document.head.appendChild(script);
      }
    }
  }, []);
}
