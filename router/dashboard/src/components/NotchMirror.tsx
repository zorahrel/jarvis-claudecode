import { useEffect, useRef, useState } from 'react'

// Renders the exact same orb bundle the DynamicNotchKit WKWebView uses, so
// the dashboard and the Noce are visually identical. The iframe loads
// `/notch/orb/notch.html` (NOT the directory `/notch/orb/`, which falls
// through to the dashboard SPA index). Behavior mirrors the native tray:
// hover-to-expand + mouse-out-to-collapse, with a "sticky" mode while the
// user is typing in the notch's input.

const COMPACT_W = 200
const COMPACT_H = 32
const EXPANDED_W = 420
const EXPANDED_H = 540
const COLLAPSE_DELAY_MS = 60

export function NotchMirror() {
  const [expanded, setExpanded] = useState(false)
  const [sticky, setSticky] = useState(false)
  const collapseTimer = useRef<number | null>(null)

  // Keep the iframe mounted ALWAYS so the WebGL orb stays warm and we don't
  // pay the cold-start every hover. We just swap container dimensions around
  // it — same strategy the Swift side uses with its preloadWindow.

  const cancelCollapse = () => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current)
      collapseTimer.current = null
    }
  }

  const scheduleCollapse = () => {
    cancelCollapse()
    if (sticky) return
    collapseTimer.current = window.setTimeout(() => {
      setExpanded(false)
    }, COLLAPSE_DELAY_MS)
  }

  const onEnter = () => {
    cancelCollapse()
    setExpanded(true)
  }
  const onLeave = () => {
    if (sticky) return
    scheduleCollapse()
  }

  // The iframe's notch.js posts `inputChange` messages when the user types,
  // so we can latch sticky here too and refuse to collapse on mouse-out
  // (same semantics as the Swift controller).
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const body = ev.data
      if (!body || typeof body !== 'object') return
      if (body.type === 'inputChange') {
        setSticky(!!body.hasText)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Global click-outside dismisses the panel even while sticky (matches the
  // CGEvent outside-click behavior on the real notch).
  useEffect(() => {
    if (!expanded) return
    const onDocClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null
      if (!el?.closest?.('[data-notch-mirror]')) {
        setSticky(false)
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [expanded])

  // Chromium has a long-standing bug where `border-radius` + `overflow:
  // hidden` on a container that holds an iframe forces the iframe to be
  // rasterized as a bitmap → the orb canvas inside comes out grainy. Using
  // `clip-path: inset(...)` clips without triggering the bitmap path, so
  // the iframe stays compositor-GPU-backed and crisp. We keep the rounded
  // corners on the chrome (background + border) via a sibling overlay.
  const wrapStyle: React.CSSProperties = {
    position: 'fixed',
    top: 8,
    left: `calc(50% - ${(expanded ? EXPANDED_W : COMPACT_W) / 2}px)`,
    zIndex: 9000,
    width: expanded ? EXPANDED_W : COMPACT_W,
    height: expanded ? EXPANDED_H : COMPACT_H,
    transition:
      'width 0.28s cubic-bezier(0.22, 1, 0.36, 1), height 0.28s cubic-bezier(0.22, 1, 0.36, 1), left 0.28s cubic-bezier(0.22, 1, 0.36, 1)',
    clipPath: `inset(0 round ${expanded ? 22 : 999}px)`,
    // Opaque dashboard background color — same hex the body uses. The iframe
    // is painted on top, so any transparent pixel (orb corners, FOUC before
    // three.js mounts, etc.) reveals this dark layer, never the browser's
    // default light canvas.
    background: 'var(--bg-0)',
    boxShadow: expanded
      ? '0 20px 50px rgba(0,0,0,0.45)'
      : '0 4px 14px rgba(0,0,0,0.35)',
  }

  const iframeStyle: React.CSSProperties = {
    width: EXPANDED_W,
    height: EXPANDED_H,
    border: 'none',
    // Match the wrapper so the iframe element itself renders on a dark
    // canvas — belt-and-braces in case the hosted document's body background
    // hasn't applied yet (FOUC) or Chromium's default `color-scheme: light`
    // leaks through on the `html` root before CSS lands.
    background: 'var(--bg-0)',
    colorScheme: 'dark',
    display: 'block',
    // Pin the iframe at its natural expanded size. The wrapper grows/shrinks
    // AROUND it and clips via `overflow: hidden`. That way the three.js
    // canvas is never resized during the transition — no stretch, no blur,
    // exactly the same fix used on the Swift side for WKWebView.
    position: 'absolute',
    top: 0,
    left: (expanded ? 0 : (COMPACT_W - EXPANDED_W) / 2),
    transition: 'left 0.28s cubic-bezier(0.22, 1, 0.36, 1)',
  }

  const compactOverlayStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 2,
    display: expanded ? 'none' : 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  }

  return (
    <div
      data-notch-mirror
      style={wrapStyle}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <iframe
        // `?embed=dashboard` makes the router inject a dark-background style
        // override into notch.html. Without it, the document is transparent
        // (required by the WKWebView notch over the desktop) and the browser
        // paints a white canvas behind the orb. The native tray app still
        // loads the URL without the query, so its notch stays transparent.
        src="/notch/orb/notch.html?embed=dashboard"
        title="Jarvis Noce"
        style={iframeStyle}
        allow="autoplay; clipboard-write"
      />
      <div style={compactOverlayStyle}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            // Palette is intentionally identical to the Swift-side NotchDot
            // so the dashboard mirror and the native notch share a single
            // closed-state icon. Any change here MUST be mirrored in
            // tray-app NotchController.swift `NotchDot`.
            background:
              'radial-gradient(circle at 35% 35%, rgb(255, 199, 102), rgb(255, 140, 51))',
            boxShadow: '0 0 6px rgba(255, 178, 77, 0.7)',
          }}
        />
      </div>
    </div>
  )
}
