import SwiftUI
import AppKit
import ObjectiveC.runtime
import WebKit
import DynamicNotchKit

// MARK: - Controller

/// Owns the single `DynamicNotch` instance that hosts the Jarvis orb. The
/// expanded state renders a WKWebView pointing at the local orb bundle
/// (forked from openclaw-jarvis-ui). Compact leading/trailing show a tiny
/// SwiftUI orb preview + session count.
@MainActor
final class NotchController: ObservableObject {
    static let shared = NotchController()

    @Published var connected: Bool = false
    @Published var activeCount: Int = 0
    @Published var pendingCount: Int = 0
    @Published private(set) var state: NotchAgentState = .idle
    @Published private(set) var isExpanded: Bool = false
    @Published private(set) var focus: ExpandFocus = .chat

    /// Per-channel activity level, 0…1, indexed telegram=0, whatsapp=1,
    /// discord=2, notch=3. Decays toward 0 over ~2s since last event so the
    /// trailing bars show a meaningful "what's live" snapshot without needing
    /// a separate metrics stream.
    @Published private(set) var channelLevels: [Double] = [0, 0, 0, 0]

    private var notch: DynamicNotch<AnyView, AnyView, AnyView>?

    /// Single shared WKWebView — preloaded at mount() so the orb's three.js
    /// scene is already warm when the user expands the notch the first time.
    /// Detached/re-attached into the expanded container instead of rebuilt,
    /// which kills the 500-800 ms cold-start lag AND the black flash.
    private(set) lazy var webView: WKWebView = makeWebView()
    private var preloadWindow: NSWindow?

    /// Global click monitor installed while expanded so clicks anywhere
    /// outside the panel collapse it back to compact.
    // outsideClickMonitor removed — dismissal routed through NotchEventTap
    // (see installNotchEventTap). NSEvent globals miss notch-cutout clicks.

    /// Always-on click monitor — best-effort only because macOS routes many
    /// clicks in the notch cutout area to windows that don't forward to
    /// NSEvent.addGlobalMonitorForEvents. We keep it for telemetry / logs.
    private var notchAreaClickMonitor: Any?

    /// CGEvent tap that catches left-mouse-down even in the physical notch
    /// cutout (the camera-housing dead zone where no NSPanel receives
    /// events, regardless of window level). Requires the user to grant
    /// Accessibility permission — without it the callback never fires and
    /// we fall back silently to icon-clicks only.
    private var notchEventTap: NotchEventTap?

    /// Whether the mouse is currently over the hover zone (compact notch area
    /// OR the expanded panel rect). Drives the auto-expand / auto-collapse.
    private var isHovering: Bool = false

    /// Set to `true` when the user has typed anything into the expanded
    /// panel's input. While sticky, mouse-out does NOT auto-collapse — only
    /// a click outside does. Cleared on compact + when input is emptied.
    private var isSticky: Bool = false

    /// Coalesces mouse-moved CGEvents: only re-evaluate hover state every
    /// ~16 ms (60 Hz) to keep the main actor unblocked.
    private var lastHoverEvalAt: TimeInterval = 0

    /// Pending collapse task spawned on mouse-out. Cancelled if the mouse
    /// re-enters before it fires, so the panel doesn't flicker during
    /// fast cursor movement near the edge.
    private var pendingCollapseTask: Task<Void, Never>?

    /// THE fix for DynamicNotchPanel invisibility on macOS Sequoia/26 with
    /// multi-display + clamshell setups. The library's panel uses
    /// `level = .screenSaver` and `[.canJoinAllSpaces, .stationary]`, which
    /// macOS now filters from WindowServer compositing when the app is an
    /// `.accessory` LSUIElement that hasn't called `activate(ignoringOtherApps:)`.
    /// Symptom: panel exists, frame correct, alpha 1, `kCGWindowIsOnscreen`
    /// undefined. After `NSApp.activate(...)` the same panel becomes
    /// `kCGWindowIsOnscreen: 1` and the user actually sees it (proven via
    /// CGWindowListCopyWindowInfo on Attilio's setup). Idempotent — safe to
    /// call after every state transition.
    func forceShowDynamicNotchPanel() {
        NSApp.activate(ignoringOtherApps: true)
        if let panel = NSApp.windows.first(where: {
            String(describing: type(of: $0)) == "DynamicNotchPanel"
        }) {
            panel.alphaValue = 1
            panel.orderFrontRegardless()
            // Keep `.accessory` policy so the dock icon doesn't appear.
            // `activate` works regardless.
            DispatchQueue.main.async {
                NSApp.setActivationPolicy(.accessory)
            }
        }
    }

    func mount() {
        guard notch == nil else { return }

        // Warm the webview first so the orb scene is already rendering by the
        // time the panel opens. We stash it in a 1×1 offscreen NSWindow so
        // macOS doesn't freeze its WebGL context while it has no parent.
        _ = self.webView
        preloadOffscreen()

        notch = DynamicNotch(
            hoverBehavior: [.keepVisible, .increaseShadow],
            // Force `.notch` — `.auto` becomes `.floating` on non-notched
            // screens, and DynamicNotchKit's `compact(on:)` is a NO-OP on
            // `.floating` (it hides the window per their docs). We pair this
            // with `targetScreen()` always returning the notched screen, so
            // the notch panel always has a real macOS notch to align with.
            style: .notch,
            expanded: { [weak self] in
                AnyView(NotchExpandedView(controller: self ?? NotchController.shared))
            },
            compactLeading: { [weak self] in
                AnyView(NotchCompactLeading(controller: self ?? NotchController.shared))
            },
            compactTrailing: { [weak self] in
                AnyView(NotchCompactTrailing(controller: self ?? NotchController.shared))
            }
        )

        // Start in compact so the Notch is visible as a tiny pill ambient state.
        // Explicit screen — DynamicNotchKit defaults to `NSScreen.screens[0]`
        // which on multi-display setups is rarely where the user looks.
        let screen = targetScreen()
        NotchLogger.shared.log("info",
            "[mount] target screen frame=\(Int(screen.frame.width))x\(Int(screen.frame.height)) " +
            "notch=\(screen.safeAreaInsets.top > 0) screens=\(NSScreen.screens.count)")
        // Use DynamicNotchKit's full visual treatment (NotchShape mask,
        // proper notch fusion, expand/compact animations). The library's
        // panel by itself reports `isVisible=false` on this user's setup —
        // the missing piece is `NSApp.activate(ignoringOtherApps: true)`,
        // which `.accessory` LSUIElement apps must call themselves for
        // WindowServer to composite their windows. We add that AFTER each
        // notch state transition.
        Task { @MainActor in
            await self.notch?.compact(on: screen)
            self.forceShowDynamicNotchPanel()
            // Swizzle DynamicNotchPanel.canBecomeKey AFTER the panel has
            // been instantiated, so the Swift @objc bridge for the getter
            // has registered. Otherwise class_getInstanceMethod returns
            // nil and we end up adding a method that the bridge later
            // overrides — and AppKit still calls the Swift @MainActor
            // getter which crashes on macOS 26 (EXC_BREAKPOINT in
            // _checkExpectedExecutor on every mouse-down inside the panel).
            Self.swizzleDynamicNotchPanelCanBecomeKey()
        }

        installNotchAreaClickMonitor()
        installNotchEventTap()
        loadPrefsFromRouter()

        NotchEventBus.shared.start { [weak self] event in
            Task { @MainActor in self?.apply(event: event) }
        }
    }

    private func installNotchEventTap() {
        notchEventTap = NotchEventTap(onNotchClick: { [weak self] inside in
            Task { @MainActor in
                guard let self else { return }
                // Click-to-dismiss: anywhere outside the expanded panel
                // collapses it AND clears sticky. Clicks inside the
                // expanded panel are swallowed by the panel's own window,
                // so we don't need to special-case that here.
                if !inside && self.isExpanded && !self.isOverExpandedPanel() {
                    self.isSticky = false
                    self.compact()
                }
            }
        })
        installHoverMonitors()
    }

    /// Hover detection via NSEvent — far cheaper than piping mouseMoved
    /// through a CGEvent tap (which would trip `tapDisabledByTimeout` on
    /// every click). Two monitors so we catch mouse-moves both in other
    /// apps (`global`) and inside any window we own (`local`).
    private var hoverGlobalMonitor: Any?
    private var hoverLocalMonitor: Any?

    private func installHoverMonitors() {
        hoverGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            self?.handleHoverEvent()
        }
        hoverLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            self?.handleHoverEvent()
            return event
        }
    }

    private func handleHoverEvent() {
        // Use whichever screen the mouse is currently on — multi-display
        // setups can't assume the notched screen is where the user looks.
        // Fall back to notchScreen() if the cursor is between displays.
        let loc = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSMouseInRect(loc, $0.frame, false) })
            ?? notchScreen()
        guard let screen else { return }
        let cgY = screen.frame.maxY - loc.y
        handleMouseMoved(cgX: loc.x, cgY: cgY)
    }

    /// Throttled hover-zone evaluator driven by CGEvent.mouseMoved. Opens
    /// the panel when the cursor enters the notch zone, schedules a close
    /// when it leaves (unless sticky is set because the user typed).
    fileprivate func handleMouseMoved(cgX: CGFloat, cgY: CGFloat) {
        let now = Date().timeIntervalSince1970
        if now - lastHoverEvalAt < 0.033 { return }
        lastHoverEvalAt = now

        let inCompactZone = isInsideCompactZone(cgX: cgX, cgY: cgY)
        let inExpandedZone = isExpanded && isInsideExpandedZone(cgX: cgX, cgY: cgY)
        let inside = inCompactZone || inExpandedZone

        // Hot-corner check — independent of inside/outside hover zone. While
        // the recorder is running, snap-to-corner aborts the session with
        // no upload. Visual warning kicks in earlier so the user gets a
        // clear "you're about to cancel" cue.
        // Hot-corner is a universal "stop Jarvis" gesture — works during
        // voice recording AND while the assistant is replying or the TTS
        // is speaking. The affordance itself is shown persistently (see
        // mount()), so the user always has visual feedback.
        let d = nearestCornerDistance()
        updateCancelAffordanceProximity(distance: d)
        // No dwell — instant abort on entering the corner radius.
        if d <= NotchTuning.cornerAbortPx {
            if streamRecorder.isRunning {
                abortHoverRecord(reason: "hot-corner")
            } else {
                interruptJarvis(reason: "hot-corner")
            }
        }
        if streamRecorder.isRunning {
            if d <= NotchTuning.cornerWarnPx && d > NotchTuning.cornerAbortPx {
                if !lastCornerWarn {
                    lastCornerWarn = true
                    evalJS("window.__notchVoiceAbortWarn && window.__notchVoiceAbortWarn(true);")
                }
            } else if lastCornerWarn {
                lastCornerWarn = false
                evalJS("window.__notchVoiceAbortWarn && window.__notchVoiceAbortWarn(false);")
            }
        } else if lastCornerWarn {
            lastCornerWarn = false
            evalJS("window.__notchVoiceAbortWarn && window.__notchVoiceAbortWarn(false);")
        }

        if inside {
            pendingCollapseTask?.cancel()
            pendingCollapseTask = nil
            // If a hover-record grace fade is running because we briefly
            // exited the zone, cancel it now — the user came back, keep
            // recording.
            cancelHoverGraceIfActive()
            if !isHovering {
                isHovering = true
                NotchLogger.shared.log("info", "[hover] enter cg=(\(Int(cgX)),\(Int(cgY)))")
                if !isExpanded { expandWithFocus(.chat) }
                maybeArmHoverRecord()
            }
        } else {
            if !isHovering { return }
            isHovering = false
            NotchLogger.shared.log("info", "[hover] leave cg=(\(Int(cgX)),\(Int(cgY))) sticky=\(isSticky)")
            cancelHoverRecord(reason: "mouse-out")
            if isSticky { return }
            pendingCollapseTask?.cancel()
            pendingCollapseTask = Task { @MainActor in
                // Short debounce so a cursor that briefly strays out and
                // comes back doesn't trigger a flicker. NotchTuning.
                // pendingCollapseSeconds (60ms default) feels instant but
                // still absorbs single-frame hover noise.
                try? await Task.sleep(for: .seconds(NotchTuning.pendingCollapseSeconds))
                if Task.isCancelled { return }
                if self.isExpanded && !self.isSticky {
                    self.compact()
                }
            }
        }
    }

    /// Screen the cursor is currently on (any of them). The pill follows
    /// the cursor across displays, so hit zones must too.
    private func cursorScreen() -> NSScreen? {
        let loc = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(loc, $0.frame, false) }
            ?? notchScreen()
    }

    /// Hover zones only react on the display the user is looking at —
    /// `NSScreen.main` is the screen owning the menubar / key window.
    /// On a 3-monitor setup the cursor briefly crosses into adjacent
    /// non-main screens whenever the user reaches for the top edge of
    /// the main one, which would otherwise expand the panel on the
    /// wrong display (and leave the user staring at a screen with no
    /// visible notch). Restrict to main + fall back to notched.
    /// IMPORTANT: hover zones must use the screen where the panel ACTUALLY
    /// lives (= `notchScreen()`), not the screen under the cursor. Otherwise
    /// on multi-monitor setups, hovering near the top-center of an external
    /// display would compute "inside compact zone" against THAT screen's
    /// center-X and trigger an expand on the MacBook (where the panel is).
    /// The cursor must be on the same screen as the panel for the zone test
    /// to be meaningful.
    private func isInsideCompactZone(cgX: CGFloat, cgY: CGFloat) -> Bool {
        guard let screen = notchScreen(), cursorScreen() == screen else { return false }
        let midX = screen.frame.midX
        return cgY >= 0
            && cgY <= NotchTuning.compactZoneMaxY
            && abs(cgX - midX) <= NotchTuning.compactZoneHalfWidth
    }

    private func isInsideExpandedZone(cgX: CGFloat, cgY: CGFloat) -> Bool {
        guard let screen = notchScreen(), cursorScreen() == screen else { return false }
        let midX = screen.frame.midX
        return cgY >= 0
            && cgY <= NotchTuning.expandedZoneMaxY
            && abs(cgX - midX) <= NotchTuning.expandedZoneHalfWidth
    }

    private func isOverExpandedPanel() -> Bool {
        let mouse = NSEvent.mouseLocation
        guard let screen = notchScreen() else { return false }
        // Convert Cocoa (bottom-up) to CG (top-down) for the check above.
        let cgY = screen.frame.maxY - mouse.y
        return isInsideExpandedZone(cgX: mouse.x, cgY: cgY)
    }

    private func notchScreen() -> NSScreen? {
        NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main
    }

    /// Display where the DynamicNotch panel should render right now.
    /// Multi-monitor reality: with 3 screens, `NSScreen.screens[0]` (the
    /// DynamicNotchKit default) is rarely the one the user is looking at.
    /// Strategy: prefer the screen under the cursor (the user clicked /
    /// hovered there → that's where they expect the pill), fall back to
    /// the physically-notched display, then to main.
    private func targetScreen() -> NSScreen {
        // Multi-monitor with an off/closed laptop: macOS may still list the
        // internal display in NSScreen.screens with a valid frame and even
        // route the cursor through it, so the panel ends up on a screen
        // the user can't see. Heuristic: prefer the cursor's screen, but
        // ONLY if it isn't the laptop's notched display when other screens
        // are available. Otherwise pick the largest non-notched external.
        // User wants the notch on the MacBook (notched screen). Same place
        // Boring.Notch puts itself.
        let loc = NSEvent.mouseLocation
        let cursor = NSScreen.screens.first { NSMouseInRect(loc, $0.frame, false) }
        let notched = NSScreen.screens.first { $0.safeAreaInsets.top > 0 }
        let externals = NSScreen.screens.filter { $0.safeAreaInsets.top == 0 }
        let largestExternal = externals.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })

        let chosen: NSScreen
        if let notched {
            chosen = notched
        } else if let largestExternal {
            chosen = largestExternal
        } else {
            chosen = cursor ?? NSScreen.main ?? NSScreen.screens[0]
        }
        NotchLogger.shared.log("info",
            "[target] cursor=(\(Int(loc.x)),\(Int(loc.y))) " +
            "→ \(Int(chosen.frame.width))x\(Int(chosen.frame.height)) " +
            "notched=\(chosen.safeAreaInsets.top > 0) " +
            "externals=\(externals.count)")
        return chosen
    }

    /// Called from the JS bridge whenever the input text changes. Sets the
    /// "sticky" flag so a mouse-out does not auto-collapse while there's
    /// still pending user input.
    func setStickyFromInput(hasText: Bool) {
        isSticky = hasText
        NotchLogger.shared.log("info", "[hover] sticky=\(hasText)")
    }

    /// Catches clicks in the physical notch cutout so the user can open the
    /// Noce by clicking "behind the notch" — not just on the SwiftUI icons
    /// to its sides. The cutout region is narrow (~180pt on 14/16" MBPs) so
    /// we limit the X span conservatively and require Y to be right at the
    /// screen top.
    private func installNotchAreaClickMonitor() {
        removeNotchAreaClickMonitor()
        notchAreaClickMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown]
        ) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                if self.isExpanded { return }
                guard let screen = NSScreen.main else { return }
                let loc = NSEvent.mouseLocation
                let frame = screen.frame
                // Widened zone: anywhere in the top 44pt of screen within
                // ±170pt of center. Catches the entire notch region plus a
                // bit of margin so clicks just beside the cutout also open.
                let nearTop = loc.y >= frame.maxY - 44
                let nearCenter = abs(loc.x - frame.midX) <= 170
                NotchLogger.shared.log("info",
                    "[click] x=\(Int(loc.x)) y=\(Int(loc.y)) maxY=\(Int(frame.maxY)) " +
                    "midX=\(Int(frame.midX)) top=\(nearTop) center=\(nearCenter)"
                )
                if nearTop && nearCenter {
                    self.expandWithFocus(.chat)
                }
            }
        }
    }

    private func removeNotchAreaClickMonitor() {
        if let m = notchAreaClickMonitor {
            NSEvent.removeMonitor(m)
            notchAreaClickMonitor = nil
        }
    }

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        // Ephemeral data store: no on-disk caches/cookies/localStorage for
        // the notch webview. The orb has no auth state, no persistent
        // user prefs (those live router-side), and no cross-session need
        // for a cache. The default `.default()` store accumulates HTTP
        // caches forever — pure waste in our case.
        config.websiteDataStore = .nonPersistent()
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        // Enable legacy file:// permissions — required for ES modules + fetch
        // from `file://` origins (three.js loads chunks via dynamic import).
        // These private KVC keys exist on preferences since macOS 10.x.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        // Pipe console.* + window.onerror into the Swift side so we can see
        // exactly what the orb is doing even when DevTools isn't open.
        let debugBootstrap = """
        (function() {
          if (window.__jarvisDebugWired) return;
          window.__jarvisDebugWired = true;
          window.__notchHost = '\(NotchEndpoints.host)';
          var send = function(level, args) {
            try {
              var text = Array.from(args).map(function(a) {
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a); } catch (e) { return String(a); }
              }).join(' ');
              window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.jarvis &&
                window.webkit.messageHandlers.jarvis.postMessage({ type: 'log', level: level, text: text });
            } catch (e) {}
          };
          ['log','info','warn','error','debug'].forEach(function(lvl) {
            var orig = console[lvl].bind(console);
            console[lvl] = function() { send(lvl, arguments); orig.apply(null, arguments); };
          });
          window.addEventListener('error', function(e) {
            send('error', ['[window.onerror]', e.message, 'at', (e.filename||'') + ':' + (e.lineno||0) + ':' + (e.colno||0)]);
          });
          window.addEventListener('unhandledrejection', function(e) {
            send('error', ['[unhandledrejection]', (e.reason && e.reason.stack) || e.reason || 'unknown']);
          });
          send('info', ['[bootstrap] notchHost=' + window.__notchHost + ' ua=' + navigator.userAgent]);
        })();
        """
        config.userContentController.addUserScript(WKUserScript(
            source: debugBootstrap,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        // Post-load probe: once the document finishes, inspect what's been
        // parsed and whether the module script executed. The bootstrap above
        // fires on every page; this one fires only after DOM is ready.
        let postLoadProbe = """
        (function() {
          var tag = function(msg) {
            window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.jarvis &&
              window.webkit.messageHandlers.jarvis.postMessage({ type: 'log', level: 'info', text: msg });
          };
          var onProbe = function() {
            var scripts = Array.from(document.querySelectorAll('script'));
            var modules = scripts.filter(function(s) { return s.type === 'module'; });
            tag('[probe] readyState=' + document.readyState +
                ' scripts=' + scripts.length +
                ' modules=' + modules.length +
                ' notchBumpStream=' + (typeof window.__notchBumpStream) +
                ' notchPush=' + (typeof window.__notchPush));
            modules.forEach(function(s, i) {
              tag('[probe] module#' + i + ' src=' + s.src + ' async=' + s.async);
            });
            var orb = document.getElementById('three-container');
            tag('[probe] #three-container=' + !!orb +
                ' children=' + (orb ? orb.children.length : 'n/a') +
                ' rect=' + (orb ? JSON.stringify({
                  w: orb.offsetWidth, h: orb.offsetHeight
                }) : 'n/a'));
          };
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
              setTimeout(onProbe, 500);
            });
          } else {
            setTimeout(onProbe, 500);
          }
        })();
        """
        config.userContentController.addUserScript(WKUserScript(
            source: postLoadProbe,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))

        let coordinator = NotchWebBridge(
            onCollapse: { [weak self] in self?.compact() },
            onLog: { level, text in NotchLogger.shared.log(level, text) },
            onVoiceStart: { [weak self] in self?.startVoice() },
            onVoiceStop: { [weak self] in self?.stopVoice() },
            onInputChange: { [weak self] hasText in self?.setStickyFromInput(hasText: hasText) },
            onHoverRecordToggle: { [weak self] on in self?.setHoverRecord(on) }
        )
        config.userContentController.add(coordinator, name: "jarvis")
        self.bridge = coordinator

        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 420, height: 540), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        // Safari Web Inspector — on macOS 13.3+ this is the easy way to debug.
        if #available(macOS 13.3, *) {
            web.isInspectable = true
        }
        web.navigationDelegate = coordinator

        // Prefer the router HTTP endpoint — WKWebView's ES module loader
        // rejects cross-file imports from `file://` origins even with
        // allowFileAccessFromFileURLs, which is why three.js never boots
        // when loaded from Bundle.module. The dashboard iframe already
        // proves the HTTP path works; we use the file:// copy only as a
        // last-resort fallback when the router is unreachable.
        // Point at the stripped-down notch.html explicitly. The directory URL
        // `/notch/orb/` resolves to the Vite demo index (or, if the dashboard
        // static fallback kicks in, to the full dashboard SPA — which is
        // exactly the "dashboard in the notch" bug).
        let remote = NotchEndpoints.orbHTML
        NotchLogger.shared.log("info", "[swift] loading orb from \(remote)")
        web.load(URLRequest(url: remote))
        return web
    }

    /// Keeps the WKWebView inside a tiny offscreen NSWindow so WebGL stays
    /// warm while the notch is compact or hidden. When the user expands the
    /// notch we detach the webview from the preload window and attach it to
    /// the visible container (see NotchExpandedView).
    private func preloadOffscreen() {
        let style: NSWindow.StyleMask = [.borderless]
        let win = NSWindow(
            contentRect: NSRect(x: -10_000, y: -10_000, width: 420, height: 540),
            styleMask: style,
            backing: .buffered,
            defer: false
        )
        win.isReleasedWhenClosed = false
        win.backgroundColor = .clear
        win.isOpaque = false
        win.alphaValue = 0.0
        win.ignoresMouseEvents = true
        win.orderOut(nil)
        let contentView = NSView(frame: win.contentView!.bounds)
        contentView.wantsLayer = true
        win.contentView = contentView
        contentView.addSubview(webView)
        webView.frame = contentView.bounds
        webView.autoresizingMask = [.width, .height]
        // Order the window in so the view is laid out, then hide it visually.
        win.orderFront(nil)
        win.alphaValue = 0.0
        self.preloadWindow = win
    }

    /// Strong ref to the bridge so it stays alive for the webview's lifetime.
    private var bridge: NotchWebBridge?

    /// Streaming recorder driving both click-to-talk (mic button) and
    /// hover-to-talk. Apple SFSpeechRecognizer provides the live transcript;
    /// the older whisper-only `VoiceRecorder` path was removed because it
    /// gave no live feedback and produced a second, incoherent UX.
    private let streamRecorder = StreamingRecorder()

    /// Apple SFSpeechRecognizer wrapper for live partial transcription
    /// during hover-record. Same recognizer openclaw Talk Mode uses; runs
    /// in parallel to the WAV capture so we have both an instant partial
    /// (great UX) AND a server-side whisper transcript as fallback.
    private let transcriber = VoiceTranscriber()

    /// Forwarded from `audioLifecycle` JS messages — true while the
    /// assistant's TTS audio element is playing. We act on three layers:
    ///
    /// 1. VoiceTranscriber drops Apple SFSpeechRecognizer buffers
    ///    (was already there before this fix).
    /// 2. If the StreamingRecorder is currently capturing, KILL the capture
    ///    without uploading. Otherwise the mic picks up the speakers, the
    ///    silence-detector eventually trips, the WAV ships to whisper-cli
    ///    on the server, and the user sees their own TTS transcribed back
    ///    as a fake user message ("STABILE ROUTER OK SERVIZIO ONLINE..." in
    ///    the screenshot). This was the most user-visible bug pre-fix.
    /// 3. Track the flag publicly so the hover-dwell arming code can refuse
    ///    to start a new capture while TTS is playing.
    func setAssistantSpeaking(_ speaking: Bool) {
        // Three-layer echo defense (any one is in theory sufficient, but they
        // catch different leak paths and add up to robust silence):
        //   1. AEC hardware (AVAudioEngine voiceProcessing) — primary defense,
        //      subtracts speaker output from mic input at the AudioUnit level.
        //   2. transcriber.setAssistantSpeaking → SFSpeechRecognizer drops
        //      buffers from its recognition request (Apple already-clean audio
        //      can still pick up TTS in some quiet rooms with speakers).
        //   3. streamRecorder.setAssistantSpeaking → file-write tap drops
        //      buffers entirely, so even if AEC + Apple let something through,
        //      the WAV that goes to whisper-cli on the server is silent.
        // The doc-comment block historically promised layer 3 but only wired
        // layer 2 — fixed here.
        transcriber.setAssistantSpeaking(speaking)
        streamRecorder.setAssistantSpeaking(speaking)
        NotchLogger.shared.log("info", "[setAssistantSpeaking] \(speaking)")
    }

    /// Safety timer that auto-resets `assistantAudioPlaying` if the WebView
    /// `audioLifecycle 'end'` event never arrives (e.g., MP3 stream errors,
    /// browser bug, network drop). Without this, the flag stuck at true would
    /// permanently lock out future hover-arm decisions that read it.
    var assistantSpeakingResetTimer: Timer?

    /// Track whether the WebView <audio> element is currently playing TTS.
    /// Set by `audioLifecycle` JS messages, read by `handleVADSpeechStart`
    /// to decide if a VAD trigger is a barge-in or just a normal start.
    /// Internal access (not private) because the WKScriptMessage handler
    /// in the extension at the bottom of this file writes to it.
    var assistantAudioPlaying: Bool = false

    /// True while the live SFSpeechRecognizer task is consuming buffers.
    /// Promoted from a local var inside startStreamingVoice() to a property
    /// so setAssistantSpeaking() can cancel the recognizer when echo guard
    /// stops the recorder mid-capture.
    private var transcriberRunning: Bool = false

    /// Silero VAD reported the user started speaking (from notch.html worker
    /// via vad-controller.js). Two outcomes:
    ///   - TTS playing → BARGE-IN: stop the local AVSpeech, tell the WebView
    ///     <audio> to stop, and POST /api/notch/barge so the router cancels
    ///     in-flight TTS streams + bumps the gen counter.
    ///   - No TTS → just a hint that the user is speaking; we don't act on
    ///     it directly because the StreamingRecorder is already capturing.
    func handleVADSpeechStart() {
        let nativeTTSPlaying = NotchSpeechSynthesizer.shared.isSpeaking()
        let webAudioPlaying = assistantAudioPlaying
        guard nativeTTSPlaying || webAudioPlaying else {
            NotchLogger.shared.log("debug", "[vad] speechStart, no TTS active — no-op")
            return
        }
        // Stop locale TTS subito (no round-trip).
        NotchSpeechSynthesizer.shared.stop()
        // Stop il <audio> element del WebView via JS bridge.
        webView.evaluateJavaScript(
            "if (window.jarvisAudio && typeof window.jarvisAudio.stop === 'function') window.jarvisAudio.stop()",
            completionHandler: nil
        )
        // Notifica il router: bumpa generation, emit audio.stop, state→recording.
        var bargeReq = URLRequest(url: NotchEndpoints.barge)
        bargeReq.httpMethod = "POST"
        bargeReq.timeoutInterval = 1.0
        URLSession.shared.dataTask(with: bargeReq).resume()
        NotchLogger.shared.log("info", "[barge-in] VAD detected user voice during TTS — interrupted")
    }

    /// Silero VAD reported the user stopped speaking. We use this as a
    /// snappier end-of-utterance signal than the StreamingRecorder's
    /// RMS-based 1.5s silence threshold — Silero kicks in around ~770ms
    /// (redemptionFrames=24) which feels much more responsive in conversation.
    func handleVADSpeechEnd() {
        streamRecorder.flushOnUserSilence()
    }

    /// Grace-period task that cancels the hover-record after a fade-out
    /// window when the cursor leaves the zone. Replaces the old immediate
    /// Cancellable grace timer that runs after a mouse-out while the
    /// recorder is still capturing. See NotchTuning.hoverRecordGraceSeconds.
    private var hoverRecordGraceTask: Task<Void, Never>?

    /// Hover-record master switch, mirrored to `~/.claude/jarvis/state/notch-prefs.json`
    /// via the router's `/api/notch/prefs`. OFF by default — hover is too
    /// trigger-happy a gesture to arm a mic automatically without user opt-in.
    @Published var hoverRecord: Bool = false

    /// Dwell timer: the user must hover CONTINUOUSLY for `NotchTuning.
    /// hoverArmDelaySeconds` before the mic arms. Cancelled if the cursor
    /// leaves inside the window.
    private var armingTask: Task<Void, Never>?
    /// Epoch of the last streaming stop — used to enforce a post-stop cooldown
    /// so a cursor that immediately re-enters the zone doesn't re-arm before
    /// the user intends to.
    private var lastStreamStopAt: TimeInterval = 0

    // MARK: Public control

    enum ExpandFocus: String { case chat, activity }

    func expand() { expandWithFocus(.chat) }

    func expandWithFocus(_ mode: ExpandFocus) {
        Task { @MainActor in
            let screen = targetScreen()
            NotchLogger.shared.log("info", "[state] expand focus=\(mode.rawValue) screen=\(Int(screen.frame.width))x\(Int(screen.frame.height))")
            self.focus = mode
            // Push focus hint into the orb so its layout reacts.
            let js = "document.documentElement.dataset.notchFocus = '\(mode.rawValue)';"
            self.webView.evaluateJavaScript(js, completionHandler: nil)
            await notch?.expand(on: screen)
            self.forceShowDynamicNotchPanel()
            self.isExpanded = true
            // Expanded chat already shows everything — no need for the peek.
            // (Both the auto-dismissing message peek AND the live-transcript
            // peek used during compact-mode hover-record need to go: in
            // expanded mode the in-webview <LivePartial/> takes over the
            // live transcript display, otherwise we'd render two bubbles.)
            self.liveTranscriptActive = false
            self.dismissPeek()
            // Health-probe the WebView. If macOS reaped the WebContent
            // process while the panel was idle in the preload window, the
            // expand reattaches a dead web view and the user sees black.
            // Reload if the probe doesn't come back.
            self.probeWebViewAlive()
        }
    }

    /// Run a no-op JS expression and force-reload ONLY if it errors out
    /// (which indicates the WebContent process died). The previous version
    /// also reloaded on a 700ms timeout, which caused false reloads during
    /// the SwiftUI re-attach animation — leading to a black flash exactly
    /// when the user opened the notch. webViewWebContentProcessDidTerminate
    /// already handles the actual death case.
    private func probeWebViewAlive() {
        webView.evaluateJavaScript("typeof window === 'object' ? 1 : 0") { [weak self] result, error in
            if let error = error {
                NotchLogger.shared.log("warn", "[probe] web alive failed: \(error.localizedDescription) — reloading")
                Task { @MainActor in self?.reloadOrb() }
                return
            }
            if (result as? Int) != 1 {
                NotchLogger.shared.log("warn", "[probe] web alive returned unexpected — reloading")
                Task { @MainActor in self?.reloadOrb() }
            }
        }
    }

    @MainActor
    private func reloadOrb() {
        let url = NotchEndpoints.orbHTML
        NotchLogger.shared.log("info", "[reload] orb \(url)")
        webView.load(URLRequest(url: url))
    }
    func compact() {
        Task { @MainActor in
            let screen = targetScreen()
            NotchLogger.shared.log("info", "[state] compact screen=\(Int(screen.frame.width))x\(Int(screen.frame.height))")
            await notch?.compact(on: screen)
            self.forceShowDynamicNotchPanel()
            self.isExpanded = false
            self.isHovering = false
            self.isSticky = false
            self.pendingCollapseTask?.cancel()
            self.pendingCollapseTask = nil
            // If a continuous-call session was running and the user clicked
            // outside (→ this `compact()` call), the panel disappears but
            // without this cleanup `inContinuousCall` + `streamRecorder`
            // would stay alive — invisible mic open in the background.
            // Sticky-call (explicit mic-button click) is preserved: the user
            // chose that mode deliberately, only corner-abort or a second
            // click on the mic button should end it.
            if self.streamRecorder.isRunning && !self.stickyCall {
                NotchLogger.shared.log("info", "[state] compact while recording (non-sticky) — ending call")
                self.inContinuousCall = false
                self.stopStreamingVoice(andUpload: true)
            } else if self.streamRecorder.isRunning && self.stickyCall {
                NotchLogger.shared.log("info", "[state] compact while sticky-call active — mic stays open")
            }
            // Park the webview offscreen again so WebGL stays alive.
            if let preload = self.preloadWindow?.contentView {
                self.webView.removeFromSuperview()
                preload.addSubview(self.webView)
                self.webView.frame = preload.bounds
            }
        }
    }
    func hide() {
        Task { @MainActor in
            await notch?.hide()
            self.isExpanded = false
        }
    }
    func toggle() {
        if isExpanded { compact() } else { expand() }
    }

    // MARK: Outside-click dismissal
    // Outside-click dismissal is handled inside `installNotchEventTap`'s
    // callback (via `onNotchClick(inside:)`). NSEvent.addGlobalMonitorForEvents
    // doesn't fire for clicks at the very top of the screen (notch cutout),
    // so routing everything through CGEvent keeps the state machine consistent.

    // MARK: Voice input

    /// True while a continuous-call session is running — silence-stops
    /// ship the utterance and re-arm the mic instead of ending the call.
    /// `didSet` logs every flip so we can trace "the call closed itself"
    /// reports back to the exact code path that cleared the flag.
    private var inContinuousCall: Bool = false {
        didSet {
            if oldValue != inContinuousCall {
                NotchLogger.shared.log("info", "[call] inContinuousCall \(oldValue) → \(inContinuousCall)")
            }
        }
    }

    /// Sub-flag of the call: true when the user explicitly clicked the
    /// mic button (sticky session — only corner/click-again ends it).
    /// Hover-armed calls keep this false so a real mouse-out + grace
    /// expiration ends the session naturally.
    private var stickyCall: Bool = false {
        didSet {
            if oldValue != stickyCall {
                NotchLogger.shared.log("info", "[call] stickyCall \(oldValue) → \(stickyCall)")
            }
        }
    }

    /// Call-button click → enter STICKY continuous-call mode. Survives
    /// mouse-out and notch-collapse; only ends via corner abort or a
    /// second click on the call button.
    func startVoice() {
        NotchLogger.shared.log("info", "[voice] enter continuous-call (sticky)")
        inContinuousCall = true
        stickyCall = true
        guard !streamRecorder.isRunning else { return }
        startStreamingVoice()
    }

    func stopVoice() {
        NotchLogger.shared.log("info", "[voice] exit continuous-call")
        inContinuousCall = false
        stickyCall = false
        if streamRecorder.isRunning {
            stopStreamingVoice(andUpload: true)
        } else {
            // Recorder already dead (e.g. start failed for permissions) —
            // still need to refresh the affordance so the X disappears.
            updateAffordanceVisibility()
        }
    }

    private func pushMicState(on: Bool) {
        let js = "window.__notchSetMicState && window.__notchSetMicState('\(on ? "on" : "off")');"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: Hover-record (streaming)

    /// Called when the mouse enters the hover zone. Starts the dwell timer;
    /// the recorder doesn't actually arm until the user has held still for
    /// `hoverArmDelaySeconds`. No-op if hoverRecord is OFF, we're already
    /// armed, or we're inside the cooldown window.
    func maybeArmHoverRecord() {
        guard hoverRecord else { return }
        guard !streamRecorder.isRunning else { return }
        let now = Date().timeIntervalSince1970
        if now - lastStreamStopAt < NotchTuning.hoverStopCooldownSeconds { return }
        armingTask?.cancel()
        armingTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(NotchTuning.hoverArmDelaySeconds))
            guard let self, !Task.isCancelled, self.isHovering else { return }
            // Hover engagement is a CALL, not a single utterance — set
            // inContinuousCall so silence re-arms the mic. NOT sticky:
            // a real mouse-out + grace expiry will still end it.
            self.inContinuousCall = true
            self.stickyCall = false
            self.startStreamingVoice()
            self.updateAffordanceVisibility()
        }
    }

    /// Called on mouse-out. Cancels any pending arm. If the recorder is
    /// running, START a grace fade-out instead of stopping immediately:
    /// the user gets ~2.5s to come back into the zone without losing the
    /// in-progress recording. The orb shows a soft accent aura that fades
    /// during the grace window. Mouse-in cancels the grace; expiry stops
    /// the recorder and ships whatever was captured.
    func cancelHoverRecord(reason: String) {
        armingTask?.cancel()
        armingTask = nil
        // Toggle-off is an explicit user signal that overrides everything,
        // even when no recorder is running yet (the user might toggle off
        // mid-dwell, before the arm fires). Clear residual call flags so
        // the next hover doesn't inherit a stale `inContinuousCall=true`
        // from a previous session that the recorder-not-running guard
        // would have skipped.
        if reason == "toggle-off" {
            NotchLogger.shared.log("info", "[hover-rec] toggle-off — ending call")
            inContinuousCall = false
            stickyCall = false
            if streamRecorder.isRunning {
                stopStreamingVoice(andUpload: true)
            }
            updateAffordanceVisibility()
            return
        }
        guard streamRecorder.isRunning else { return }
        // Once we're in a continuous call (hover-armed OR click-armed), a
        // mouse-out is no longer a "are you done?" signal — the call is
        // hands-free by design. The user ends it via the corner, the
        // toggle, or (for click-call) a second click on the phone button.
        if inContinuousCall {
            NotchLogger.shared.log("info", "[hover-rec] ignored (\(reason)) — continuous call active")
            return
        }
        if hoverRecordGraceTask != nil {
            // Already in grace; nothing new to do.
            return
        }
        NotchLogger.shared.log("info", "[hover-rec] grace start reason=\(reason)")
        let graceMs = Int(NotchTuning.hoverRecordGraceSeconds * 1000)
        evalJS("window.__notchVoiceGraceStart && window.__notchVoiceGraceStart(\(graceMs));")
        hoverRecordGraceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(NotchTuning.hoverRecordGraceSeconds))
            if Task.isCancelled { return }
            guard let self, self.streamRecorder.isRunning else { return }
            NotchLogger.shared.log("info", "[hover-rec] grace expired, stopping")
            self.evalJS("window.__notchVoiceGraceEnd && window.__notchVoiceGraceEnd();")
            // Hover-call ends here — clear the continuous flag so the
            // silence-stop path doesn't re-arm and keep the mic alive.
            self.inContinuousCall = false
            self.stopStreamingVoice(andUpload: true)
            self.hoverRecordGraceTask = nil
            self.updateAffordanceVisibility()
        }
    }

    /// Cursor returned to the hover zone while a grace fade was running —
    /// abort the grace, the recording continues uninterrupted.
    private func cancelHoverGraceIfActive() {
        if hoverRecordGraceTask != nil {
            hoverRecordGraceTask?.cancel()
            hoverRecordGraceTask = nil
            NotchLogger.shared.log("info", "[hover-rec] grace cancelled — cursor returned")
            evalJS("window.__notchVoiceGraceCancel && window.__notchVoiceGraceCancel();")
        }
    }

    /// Hot-corner abort: cursor flicked to a screen corner explicitly says
    /// "kill it, don't ship". Cancels the grace, stops the recorder + STT,
    /// and shows nothing in the chat. Different from the grace expiry path
    /// which DOES ship whatever was captured.
    private func abortHoverRecord(reason: String) {
        hoverRecordGraceTask?.cancel()
        hoverRecordGraceTask = nil
        // Hot-corner / explicit abort always exits continuous-call too.
        inContinuousCall = false
        stickyCall = false
        guard streamRecorder.isRunning else {
            // Stuck-active state (e.g. start failed for permissions and
            // flags were left half-set on an older build) — clear the
            // affordance + aura so the user isn't staring at a phantom call.
            updateAffordanceVisibility()
            return
        }
        NotchLogger.shared.log("info", "[hover-rec] abort reason=\(reason)")
        _ = streamRecorder.stop()
        if transcriber.isRunning { transcriber.cancel() }
        lastStreamStopAt = Date().timeIntervalSince1970
        pushMicState(on: false)
        hideCancelAffordance()
        evalJS("window.__notchVoiceLiveEnd && window.__notchVoiceLiveEnd();")
        evalJS("window.__notchVoiceGraceEnd && window.__notchVoiceGraceEnd();")
    }

    /// Distance from cursor to the bottom-right corner of the screen the
    /// cursor is currently on. The cancel-affordance UI (CancelAffordanceView)
    /// only paints the bottom-right corner — iterating all 12 corners across
    /// 3 monitors made the abort fire when moving toward an unrelated corner
    /// (e.g. menubar icon click on the MacBook), with no visual indication.
    /// Locking the gesture to the cursor's screen + bottom-right matches the
    /// affordance the user sees.
    private func nearestCornerDistance() -> CGFloat {
        let mouse = NSEvent.mouseLocation
        guard let s = cursorScreen() else { return .infinity }
        let f = s.frame
        let dx = mouse.x - f.maxX
        let dy = mouse.y - f.minY
        return (dx * dx + dy * dy).squareRoot()
    }

    /// Px from the corner where abort fires (must commit fully). Within
    /// `NotchTuning.cornerWarnPx` we paint a red ring as a "you're about to
    /// abort" hint. Constants live in NotchConstants.swift.
    private var lastCornerWarn: Bool = false

    /// Bottom-right cancel affordance — small standalone NSPanel shown
    /// while the mic is open. Renders a quarter-circle backdrop + X icon
    /// that scales and pulses as the cursor nears the corner so the user
    /// has a visible target instead of a magic invisible zone.
    private var cancelAffordancePanel: NSPanel?
    private var cancelAffordanceView: CancelAffordanceView?

    func showCancelAffordance(on screen: NSScreen) {
        if cancelAffordancePanel == nil {
            let p = NSPanel(
                contentRect: .zero,
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = false
            p.ignoresMouseEvents = true
            p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 4)
            p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
            let v = CancelAffordanceView(frame: NSRect(origin: .zero, size: NSSize(width: 320, height: 320)))
            p.contentView = v
            cancelAffordancePanel = p
            cancelAffordanceView = v
        }
        let f = screen.frame
        let size: CGFloat = 320
        // Panel shifted so the disc's CENTRE lands on the screen corner
        // and only one quadrant is on-screen. With anchor=(1,0) inside the
        // view, the disc grows out from that exact point.
        let rect = NSRect(
            x: f.maxX - size,
            y: f.minY,
            width: size,
            height: size
        )
        cancelAffordancePanel?.setFrame(rect, display: true)
        cancelAffordancePanel?.alphaValue = 1
        cancelAffordancePanel?.orderFrontRegardless()
    }

    func hideCancelAffordance() {
        // Just resets proximity — actual show/hide is driven by
        // `updateAffordanceVisibility()` toggling the view's `isActive`.
        cancelAffordanceView?.setProximity(0)
        updateAffordanceVisibility()
    }

    func updateCancelAffordanceProximity(distance: CGFloat) {
        // Proximity 0 (far) → 1 (at corner). Use NotchTuning.cornerWarnPx as
        // the start of the visible engagement; below cornerAbortPx it's
        // full-bleed red.
        let warn = NotchTuning.cornerWarnPx
        let abort = NotchTuning.cornerAbortPx
        let p: CGFloat
        if distance >= warn { p = 0 }
        else if distance <= abort { p = 1 }
        else { p = (warn - distance) / (warn - abort) }
        cancelAffordanceView?.setProximity(p)
    }

    private func startStreamingVoice() {
        // NOTE: Pre-arm echo refusal removed (was causing stuck-mic-off bug
        // when audioLifecycle 'end' didn't fire — flag stayed true forever).
        // Echo handling now relies on:
        //   1. setAssistantSpeaking(true) → VoiceTranscriber drops buffers
        //   2. setAssistantSpeaking(true) → kills mic mid-capture if it was open
        //      when TTS started (no upload, log [echo-guard])
        // The mic re-opens normally on every hover. If TTS happens to start
        // RIGHT AFTER arm completes, layer 2 cleans up within milliseconds.
        NotchLogger.shared.log("info", "[hover-rec] start")
        // Reset state used to gate aura colour transitions so the first
        // partial-level event in this session reliably triggers the
        // "listening → voiced" CSS class swap.
        lastVoicedState = false
        pushMicState(on: true)
        // Show the bottom-right cancel affordance — quarter-circle with X
        // that scales toward the cursor as it nears the corner.
        updateAffordanceVisibility()
        // Web side: open the live transcript bubble. Partials will stream
        // into it as Apple's recognizer updates its hypothesis.
        evalJS("window.__notchVoiceLiveStart && window.__notchVoiceLiveStart();")
        // Wake up Silero VAD so barge-in (interrupting Jarvis mid-TTS) and
        // snappy end-of-utterance flushing both work. The VAD module is
        // loaded eagerly at notch boot but stays dormant until we start it
        // here — keeps getUserMedia OFF until the user actually wants
        // to talk. `start()` is idempotent so re-arming is safe.
        evalJS("window.jarvisVAD && window.jarvisVAD.start && window.jarvisVAD.start();")

        // STT is REQUIRED in the Apple-only policy: if transcriber.start fails
        // (permission denied / .notDetermined), every utterance would be
        // silently discarded later in stopStreamingVoice. Surface a clear
        // error to the user via the peek and abort the arming flow instead
        // of leaving an invisible "always-on but always-empty" mic.
        do {
            try transcriber.start(
                onPartial: { [weak self] text in
                    Task { @MainActor in self?.pushVoicePartial(text: text) }
                },
                onFinal: { [weak self] text in
                    Task { @MainActor in self?.pushVoiceFinal(text: text) }
                }
            )
            self.transcriberRunning = true
        } catch {
            let nsErr = error as NSError
            NotchLogger.shared.log("warn", "[hover-rec] transcriber unavailable: \(nsErr.localizedDescription)")
            if !isExpanded {
                showMessagePeek(role: .assistant, text: "Riconoscimento vocale non disponibile (\(nsErr.code)). Vai in Impostazioni → Privacy.")
            }
            pushMicState(on: false)
            inContinuousCall = false
            stickyCall = false
            hideCancelAffordance()
            updateAffordanceVisibility()
            evalJS("window.__notchVoiceLiveEnd && window.__notchVoiceLiveEnd();")
            evalJS("window.jarvisVAD && window.jarvisVAD.pause && window.jarvisVAD.pause();")
            return
        }

        do {
            try streamRecorder.start(
                onPartial: { [weak self] level in
                    Task { @MainActor in self?.pushPartialLevel(level) }
                },
                onSilenceDetected: { [weak self] in
                    Task { @MainActor in
                        guard let self, self.streamRecorder.isRunning else { return }
                        NotchLogger.shared.log("info", "[hover-rec] silence detected, auto-stop")
                        self.stopStreamingVoice(andUpload: true)
                    }
                },
                onBuffer: { [weak self] buf in
                    // Forwarded from the audio tap thread; safe to call
                    // SFSpeechAudioBufferRecognitionRequest.append from there.
                    self?.transcriber.append(buffer: buf)
                }
            )
        } catch {
            NotchLogger.shared.log("error", "[hover-rec] start failed: \(error.localizedDescription)")
            pushMicState(on: false)
            // Roll back the call flags — the recorder never started, so a
            // stuck "active" call would otherwise show the aura + X with
            // no actual mic, and the exit paths can't clear it because
            // they early-return on `streamRecorder.isRunning == false`.
            inContinuousCall = false
            stickyCall = false
            hideCancelAffordance()
            updateAffordanceVisibility()
            evalJS("window.__notchVoiceLiveEnd && window.__notchVoiceLiveEnd();")
            evalJS("window.jarvisVAD && window.jarvisVAD.pause && window.jarvisVAD.pause();")
            if self.transcriberRunning { transcriber.cancel(); self.transcriberRunning = false }
        }
    }

    private func stopStreamingVoice(andUpload: Bool) {
        guard streamRecorder.isRunning else { return }
        let heardVoice = streamRecorder.hadVoice
        let url = streamRecorder.stop()
        let appleText = transcriber.isRunning ? transcriber.stop() : ""
        lastStreamStopAt = Date().timeIntervalSince1970
        pushMicState(on: false)
        hideCancelAffordance()
        evalJS("window.__notchVoiceLiveEnd && window.__notchVoiceLiveEnd();")
        // Pause VAD now that the recorder isn't listening.
        evalJS("window.jarvisVAD && window.jarvisVAD.pause && window.jarvisVAD.pause();")
        // Hide the live-transcript peek now. If `andUpload` succeeds, the
        // router will echo back `messageOut` which re-renders a normal
        // (auto-dismissing) user peek — no double bubble.
        dismissLiveTranscriptPeek()
        // Only ship the WAV if VAD actually saw voiced audio. A mouse-out
        // after 200 ms of pure room tone otherwise hits whisper-cli, which
        // loves hallucinating short common words ("grazie", "ok", "ciao")
        // into empty clips and injecting them as if the user had spoken.
        guard andUpload else { return }
        guard heardVoice else {
            NotchLogger.shared.log("info", "[hover-rec] discard — no voice detected")
            return
        }
        // Apple-only policy: if SFSpeechRecognizer didn't capture anything,
        // we drop the message rather than fall back to the slow whisper
        // round-trip. Per user explicit preference: "o c'è quella veloce
        // o non facciamo nulla, perché non ha senso metterne una lenta".
        // The whisper round-trip can still be added back later if Apple
        // flakes too often — for now drop and log so the user can retry.
        _ = url
        if appleText.isEmpty {
            NotchLogger.shared.log("info", "[hover-rec] discard — Apple STT empty (whisper fallback disabled)")
            // In continuous call we still want to re-arm; otherwise a single
            // empty utterance would silently end the call.
            if inContinuousCall {
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(250))
                    guard let self, self.inContinuousCall, !self.streamRecorder.isRunning else { return }
                    self.startStreamingVoice()
                }
            }
            return
        }
        NotchLogger.shared.log("info", "[hover-rec] sending apple transcript len=\(appleText.count)")
        postTranscriptAsMessage(appleText)
        // Continuous call: re-arm the mic for the next utterance. We add a
        // small gap (250ms) so the user perceives the send/receive moment
        // and so the AVAudioEngine has time to fully tear down before the
        // next start — restarting too fast trips a CoreAudio reset.
        if inContinuousCall {
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, self.inContinuousCall, !self.streamRecorder.isRunning else { return }
                NotchLogger.shared.log("info", "[voice] continuous-call re-arm")
                self.startStreamingVoice()
            }
        }
    }

    /// Forward Apple's partial hypothesis to the JS side. The orb shows it
    /// in a "live transcript" user bubble that grows in place as Apple
    /// refines the recognition.
    ///
    /// In COMPACT mode the WKWebView is parked offscreen in `preloadWindow`
    /// (see `preloadOffscreen()` and `compact()`), so the JS bubble would be
    /// rendered into a window the user can't see. We mirror the partial into
    /// the native `MessagePeekView` (NSPanel sotto la notch fisica) so the
    /// user gets the live transcript even without expanding the panel.
    private func pushVoicePartial(text: String) {
        let escaped = jsString(text)
        evalJS("window.__notchVoicePartial && window.__notchVoicePartial(\(escaped));")
        if !isExpanded {
            showLiveTranscriptPeek(text: text)
        }
    }

    /// Final transcript from Apple — clears the partial state. The actual
    /// "send to agent" still happens in `stopStreamingVoice` so we can
    /// pick between Apple text and whisper text in one place.
    ///
    /// In compact, also update the live peek with the final text so the
    /// user sees the recognized utterance for a moment before the
    /// `messageOut` echo arrives from the router with the same text
    /// (which would re-render via `showMessagePeek(role: .user, …)`).
    private func pushVoiceFinal(text: String) {
        let escaped = jsString(text)
        evalJS("window.__notchVoiceFinal && window.__notchVoiceFinal(\(escaped));")
        if !isExpanded {
            showLiveTranscriptPeek(text: text)
        }
    }

    /// POST the user's transcript to the same `/api/notch/send` endpoint
    /// the text input uses. Skips the whisper round-trip when Apple gave
    /// us a usable transcription. The router echoes back as `message.out`,
    /// which the existing chat layer renders.
    private func postTranscriptAsMessage(_ text: String) {
        // `from: "notch-voice"` (not "notch") so the SSE handler in notch.html
        // renders the user bubble. The 'notch' value is suppressed there
        // because the bundled JS pushes typed input locally — for voice we
        // need the SSE echo to be the source of truth.
        guard let body = try? JSONSerialization.data(withJSONObject: ["text": text, "from": "notch-voice"]) else { return }
        var req = URLRequest(url: NotchEndpoints.send)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        URLSession.shared.dataTask(with: req).resume()
    }

    private func evalJS(_ js: String) {
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func jsString(_ s: String) -> String {
        // JSON-encode to escape quotes / newlines / unicode safely.
        guard let data = try? JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed]),
              let str = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        // Result is `["…"]`; strip the array brackets.
        return String(str.dropFirst().dropLast())
    }

    private func pushPartialLevel(_ level: Float) {
        let clamped = max(0, min(1, level * 8))  // scale RMS → visible band
        // Cross 0.18 = roughly the floor where the user is clearly speaking
        // (matches StreamingRecorder's silence threshold * a few). Push the
        // boolean transitions to JS so the aura can flip between "ascolto"
        // (cyan) and "parlando" (green) without polling.
        let voiced = clamped > NotchTuning.voicedRmsThreshold
        if voiced != lastVoicedState {
            lastVoicedState = voiced
            let evt = voiced ? "window.__notchVoiceVoiced && window.__notchVoiceVoiced();"
                             : "window.__notchVoiceSilent && window.__notchVoiceSilent();"
            webView.evaluateJavaScript(evt, completionHandler: nil)
        }
        let js = "window.__notchPartialLevel && window.__notchPartialLevel(\(clamped));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }
    private var lastVoicedState: Bool = false

    /// Called from the JS bridge when the user flips the hover-record toggle
    /// in the notch toolbar. Persisted server-side so both surfaces (native
    /// tray + dashboard mirror) end up with the same pref after a reload.
    func setHoverRecord(_ on: Bool, persist: Bool = true) {
        guard hoverRecord != on else { return }
        hoverRecord = on
        NotchLogger.shared.log("info", "[pref] hoverRecord=\(on)")
        if !on { cancelHoverRecord(reason: "toggle-off") }
        if persist {
            Task { @MainActor in await self.postPrefPatch(["hoverRecord": on]) }
        }
    }

    private func postPrefPatch(_ patch: [String: Bool]) async {
        guard let body = try? JSONSerialization.data(withJSONObject: patch) else { return }
        var req = URLRequest(url: NotchEndpoints.prefs)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        _ = try? await URLSession.shared.data(for: req)
    }

    /// One-shot prefs fetch at mount(). Best-effort; failures just leave us
    /// on the compiled-in defaults.
    private func loadPrefsFromRouter() {
        Task { @MainActor in
            do {
                let (data, _) = try await URLSession.shared.data(from: NotchEndpoints.prefs)
                if let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let h = obj["hoverRecord"] as? Bool {
                    self.setHoverRecord(h, persist: false)
                }
            } catch {
                NotchLogger.shared.log("warn", "[pref] load failed: \(error.localizedDescription)")
            }
        }
    }


    private func apply(event: NotchEvent) {
        connected = true
        switch event {
        case .stateChange(let s):
            state = s
            if s == .thinking {
                pendingCount += 1
                bumpChannel(index: 3) // notch bar
            }
            else if s == .idle { pendingCount = max(0, pendingCount - 1) }
            Task { @MainActor in self.updateAffordanceVisibility() }
        case .messageIn(let text):
            bumpChannel(index: 3)
            if !isExpanded { showMessagePeek(role: .assistant, text: text) }
        case .messageOut(let text, _):
            // User echo — show the user's just-sent message under the notch
            // when compact, so they get visual confirmation without expanding.
            if !isExpanded { showMessagePeek(role: .user, text: text) }
        case .messageChunk:
            // UI-only event, handled by the notch.html chat log. We still
            // bump the channel bar on the first chunk so the ambient
            // indicator pulses while the agent is streaming.
            bumpChannel(index: 3)
        case .toolRunning:
            bumpChannel(index: 3)
        case .agentMeta:
            break
        case .ttsSpeak(let text, let voice):
            NotchSpeechSynthesizer.shared.speak(text, voiceId: voice)
        case .ttsStop:
            NotchSpeechSynthesizer.shared.stop()
        }
    }

    /// Per-slot decay tasks. We keep one handle per channel index so that
    /// rapid bumps (e.g. SSE messageChunk burst during streaming) cancel
    /// the previous decay loop instead of stacking — without this, a
    /// 30-iteration decay × N concurrent bumps fights itself: each loop
    /// reads stale `channelLevels[i]` and sets a clamped value, so the
    /// effective decay is wrong and the bar flickers.
    private var channelDecayTasks: [Task<Void, Never>?] = [nil, nil, nil, nil]

    /// Inject activity into one of the four channel bars. Decays over ~2s.
    func bumpChannel(index: Int) {
        guard index >= 0 && index < channelLevels.count else { return }
        var next = channelLevels
        next[index] = min(1.0, next[index] + NotchTuning.channelBumpBoost)
        channelLevels = next
        // Cancel any in-flight decay for this slot so a single decay loop
        // owns the channel until completion (or the next bump).
        let targetIndex = index
        channelDecayTasks[targetIndex]?.cancel()
        channelDecayTasks[targetIndex] = Task { @MainActor [weak self] in
            for _ in 0..<30 {
                try? await Task.sleep(for: .milliseconds(NotchTuning.channelDecayTickMs))
                if Task.isCancelled { return }
                guard let self else { return }
                if self.channelLevels[targetIndex] <= 0 { return }
                var decayed = self.channelLevels
                decayed[targetIndex] = max(0, decayed[targetIndex] - NotchTuning.channelDecayStep)
                self.channelLevels = decayed
            }
        }
    }

    /// One-shot runtime patch — replaces DynamicNotchPanel's Swift
    /// `canBecomeKey` getter (which trips the @MainActor executor check
    /// from AppKit's mouse-down path on macOS 26) with a plain ObjC IMP
    /// that returns YES. Idempotent.
    private static var didSwizzleCanBecomeKey = false
    private static func swizzleDynamicNotchPanelCanBecomeKey() {
        if didSwizzleCanBecomeKey { return }
        let candidates = [
            "DynamicNotchKit.DynamicNotchPanel",
            "_TtC17DynamicNotchKit18DynamicNotchPanel",
            "DynamicNotchPanel",
        ]
        guard let cls = candidates.compactMap({ NSClassFromString($0) }).first else {
            NotchLogger.shared.log("warn", "[swizzle] DynamicNotchPanel class not found — skipping")
            return
        }
        NotchLogger.shared.log("info", "[swizzle] target class = \(NSStringFromClass(cls))")

        // Walk every selector in the class's instance-method list — the
        // Swift @objc bridge for `canBecomeKey` may register under a name
        // that doesn't match the obvious selector string, especially for
        // boolean-property getters. We look for any selector whose name
        // contains "canBecomeKey" and replace its IMP.
        var count: UInt32 = 0
        var matched = false
        if let methods = class_copyMethodList(cls, &count) {
            for i in 0..<Int(count) {
                let m = methods[i]
                let name = NSStringFromSelector(method_getName(m))
                if name.lowercased().contains("canbecomekey") {
                    let block: @convention(block) (AnyObject) -> ObjCBool = { _ in true }
                    let imp = imp_implementationWithBlock(block as Any)
                    let prev = method_setImplementation(m, imp)
                    NotchLogger.shared.log(
                        "info",
                        "[swizzle] replaced IMP for \(name) (prev=\(String(describing: prev)))"
                    )
                    matched = true
                }
            }
            free(methods)
        }
        if !matched {
            // Fall back to the parent class (NSPanel/NSWindow) so AppKit's
            // dispatch path at least lands on a no-crash IMP. This won't
            // override DynamicNotchPanel's getter but neutralises the
            // Swift @MainActor wrapper as a backup.
            NotchLogger.shared.log("warn", "[swizzle] no canBecomeKey method on \(NSStringFromClass(cls))")
        }
        didSwizzleCanBecomeKey = true
    }

    /// Called from SwiftUI Canvas to read a per-channel level at render time.
    func channelLevel(at index: Int) -> Double {
        guard index >= 0 && index < channelLevels.count else { return 0 }
        return channelLevels[index]
    }

    // MARK: - Compact-mode message peek

    /// Borderless panel shown just below the system notch cutout when a
    /// message arrives in compact mode. Surfaces the user's just-sent
    /// message + the assistant's reply without forcing the user to
    /// expand the notch. Auto-fades after a few seconds.
    private var peekPanel: NSPanel?
    private var peekView: MessagePeekView?
    private var peekDismissTask: Task<Void, Never>?

    enum PeekRole { case user, assistant }

    func showMessagePeek(role: PeekRole, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task { @MainActor in
            self.presentPeek(role: role, text: trimmed, autoDismiss: true)
        }
    }

    /// Dedicated entry-point for the live STT bubble in compact mode.
    /// Reuses the same NSPanel as `showMessagePeek` but DOES NOT schedule an
    /// auto-dismiss task — partials would otherwise vanish if the user pauses
    /// for >5 s. Dismissal is driven explicitly by `stopStreamingVoice` and
    /// `expandWithFocus` (so opening the panel hands the live transcript over
    /// to the in-webview `<LivePartial/>` without a duplicated bubble).
    @MainActor
    func showLiveTranscriptPeek(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        liveTranscriptActive = true
        presentPeek(role: .user, text: trimmed, autoDismiss: false)
    }

    @MainActor
    func dismissLiveTranscriptPeek() {
        guard liveTranscriptActive else { return }
        liveTranscriptActive = false
        dismissPeek()
    }

    /// True while a live STT peek is on screen (compact-mode hover-record).
    /// Used to (a) guard the auto-dismiss in `presentPeek` and (b) ensure
    /// `expandWithFocus` and `stopStreamingVoice` clean it up.
    private var liveTranscriptActive: Bool = false

    @MainActor
    private func presentPeek(role: PeekRole, text: String, autoDismiss: Bool = true) {
        let screen = targetScreen()
        if peekPanel == nil {
            let p = NSPanel(
                contentRect: .zero,
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = false
            p.ignoresMouseEvents = true
            p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 4)
            p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
            let v = MessagePeekView(frame: .zero)
            p.contentView = v
            peekPanel = p
            peekView = v
        }
        peekView?.set(role: role, text: text)

        // True notch height from macOS. Falls back to 38px on Macs without
        // a physical notch so the peek still aligns under the menu bar.
        let f = screen.frame
        let notchH: CGFloat = max(screen.safeAreaInsets.top, 38)
        let width: CGFloat = min(NotchTuning.peekMaxWidth, f.width - 120)
        let height: CGFloat = peekView?.preferredHeight(forWidth: width) ?? 44
        // Top edge of the panel = bottom edge of the notch cutout, exactly.
        // No gap, so the concave top corners (drawn by MessagePeekView's
        // NotchShape layer) flow seamlessly out of the system notch.
        let rect = NSRect(
            x: f.midX - width / 2,
            y: f.maxY - notchH - height,
            width: width,
            height: height
        )
        peekPanel?.setFrame(rect, display: true)
        peekPanel?.alphaValue = 1
        peekPanel?.orderFrontRegardless()
        peekView?.animateIn()

        peekDismissTask?.cancel()
        peekDismissTask = nil
        if autoDismiss {
            peekDismissTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(NotchTuning.peekAutoDismissSeconds))
                guard let self, !Task.isCancelled else { return }
                self.dismissPeek()
            }
        }
    }

    // MARK: - Notch aura (compact-mode glow around system cutout)

    private var notchAuraPanel: NSPanel?
    private var notchAuraView: NotchAuraView?
    private var notchAuraVisible: Bool = false

    @MainActor
    private func updateNotchAuraPanel() {
        let screen = targetScreen()
        if notchAuraPanel == nil {
            let p = NSPanel(
                contentRect: .zero,
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = false
            p.ignoresMouseEvents = true
            // Sit ABOVE the DynamicNotchPanel so the halo bleeds out from
            // behind the system notch even while the panel is expanded
            // (call mode). At mainMenu+3 the expanded panel was covering
            // the wings; +8 keeps us reliably on top.
            p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 8)
            p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
            let v = NotchAuraView(frame: .zero)
            p.contentView = v
            notchAuraPanel = p
            notchAuraView = v
        }
        // Span enough horizontal area for the halo bloom to read clearly
        // on either side of the system notch (cutout is ~200px on 14",
        // ~210px on 16"). Vertically: notch height + room for the shadow
        // radius (~22px breathing) so the bottom curve isn't clipped.
        let f = screen.frame
        let notchH = max(screen.safeAreaInsets.top, 38)
        let auraWidth: CGFloat = 440
        let auraHeight: CGFloat = notchH + 40
        let rect = NSRect(
            x: f.midX - auraWidth / 2,
            y: f.maxY - auraHeight,
            width: auraWidth,
            height: auraHeight
        )
        notchAuraPanel?.setFrame(rect, display: true)
        notchAuraView?.notchHeight = notchH
        notchAuraView?.setActive(notchAuraVisible)
        // Always re-assert front order while active. DynamicNotch's expand
        // animation reorders its own panel on every transition; without
        // this the aura silently sinks behind the chat panel after the
        // first compact→expand cycle in continuous-call mode.
        if notchAuraVisible {
            notchAuraPanel?.orderFrontRegardless()
        } else {
            // When inactive, actually orderOut so the panel stops appearing
            // in NSApp.windows enumerations (and the AppKit window server
            // can release its surface). The view's alpha is already 0 via
            // `setActive(false)` but the panel itself was lingering in the
            // window stack indefinitely.
            notchAuraPanel?.orderOut(nil)
        }
    }

    /// Hot-corner interrupt when the mic is NOT recording: kill any in-
    /// flight TTS playback so the user can shut Jarvis up by flicking the
    /// cursor to the bottom-right corner. Server-side agent abort isn't
    /// wired yet — this just silences the assistant locally for now.
    @MainActor
    private func interruptJarvis(reason: String) {
        let now = Date().timeIntervalSince1970
        if now - lastInterruptAt < NotchTuning.interruptCooldownSeconds { return }
        lastInterruptAt = now
        NotchLogger.shared.log("info", "[interrupt] \(reason)")
        // 1. Local TTS via AVSpeechSynthesizer
        NotchSpeechSynthesizer.shared.stop()
        // 2. Server-side: cancel any in-flight assistant reply
        var abortReq = URLRequest(url: NotchEndpoints.abort)
        abortReq.httpMethod = "POST"
        abortReq.timeoutInterval = 3
        URLSession.shared.dataTask(with: abortReq).resume()
        // 3. WebView <audio> playback (mp3 streamed via audio.play)
        evalJS("(function(){var a=document.querySelector('audio');if(a){try{a.pause();a.currentTime=0;}catch(_){}}})();")
        // Force state back to idle locally so the affordance hides as
        // soon as the user releases the corner — the server's idle
        // emit might race the next status read.
        state = .idle
        updateAffordanceVisibility()
    }
    private var lastInterruptAt: TimeInterval = 0

    /// The cancel affordance + notch aura are scoped to CALL mode only —
    /// the X exists to end the call, not to interrupt the agent's reply
    /// (the hot-corner gesture still works for that, just without an
    /// always-on visible target).
    private var hasCancelableActivity: Bool {
        if streamRecorder.isRunning { return true }
        if inContinuousCall { return true }
        return false
    }

    @MainActor
    func updateAffordanceVisibility() {
        // The panel stays always-allocated and on-screen; visibility is
        // gated via the view's alpha (`setActive`) so transitions between
        // utterances in continuous-call don't flicker the panel away.
        showCancelAffordance(on: targetScreen())
        cancelAffordanceView?.setActive(hasCancelableActivity)
        // Voice-mode aura around the system notch — only visible while
        // there's something cancellable (recording or agent active).
        notchAuraVisible = hasCancelableActivity
        updateNotchAuraPanel()
    }

    @MainActor
    func dismissPeek() {
        peekDismissTask?.cancel()
        peekDismissTask = nil
        guard let p = peekPanel, p.isVisible else { return }
        peekView?.animateOut { [weak self] in
            Task { @MainActor in self?.peekPanel?.orderOut(nil) }
        }
    }
}

// NOTE: MessagePeekView + NotchAuraView moved to NotchViews.swift

// NOTE: NotchEventTap moved to NotchEventTap.swift

// NOTE: NotchCompactLeading/Trailing, NotchGlowFill, NotchDot,
//       NotchExpandedView, SharedWebContainer moved to NotchViews.swift
// NOTE: NotchAgentState + NotchEvent moved to NotchEvents.swift
// NOTE: NotchEventBus + SSEDelegate moved to NotchEventBus.swift
// NOTE: NotchWebBridge moved to NotchWebBridge.swift

// MARK: - Notch logger

/// Centralised logger for the Notch subsystem. Writes to stderr (visible in
/// /tmp/jarvistray.log) and also mirrors into a dedicated file so we can
/// grep for notch issues without scrolling the full tray log.
final class NotchLogger {
    static let shared = NotchLogger()
    private let url: URL
    private let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()
    private let queue = DispatchQueue(label: "jarvis.notch.logger")

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        self.url = home.appendingPathComponent(".claude/jarvis/logs/notch.log")
        // Ensure parent dir exists.
        let parent = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        // Truncate on launch so each boot has a fresh, tailable log.
        try? "".write(to: url, atomically: true, encoding: .utf8)
    }

    func log(_ level: String, _ text: String) {
        let ts = dateFormatter.string(from: Date())
        let line = "\(ts) [\(level)] \(text)\n"
        FileHandle.standardError.write(line.data(using: .utf8) ?? Data())
        queue.async { [url] in
            guard let data = line.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: url)
            }
        }
    }
}
