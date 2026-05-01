/**
 * Visual orb. CSS-only radial gradient that pulses with mic level (when
 * recording) or with the playing-audio analyser (when TTS is playing).
 * Replaces the legacy three.js bundle which was monolithic and inert.
 *
 * The aura intensity is computed by `useAura` and applied as a CSS var.
 */
import { useNotchStore } from "../store";

export function Orb() {
  const state = useNotchStore((s) => s.state);
  const micLevel = useNotchStore((s) => s.micLevel);
  const intensity = state === "recording" || state === "responding" || state === "thinking"
    ? Math.min(1, 0.4 + micLevel * 0.6)
    : 0.25;
  return (
    <div
      className={`orb state-${state}`}
      style={{ "--orb-intensity": intensity.toFixed(3) } as React.CSSProperties}
    >
      <div className="orb-core" />
      <div className="orb-glow" />
    </div>
  );
}
