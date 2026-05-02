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
        if d <= cornerAbortPx {
            if streamRecorder.isRunning {
                abortHoverRecord(reason: "hot-corner")
            } else {
                interruptJarvis(reason: "hot-corner")
            }
        }
        if streamRecorder.isRunning {
            if d <= cornerWarnPx && d > cornerAbortPx {
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
                // comes back doesn't trigger a flicker. 60 ms feels instant
                // to the user but still absorbs single-frame hover noise.
                try? await Task.sleep(for: .milliseconds(60))
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
        return cgY >= 0 && cgY <= 40 && abs(cgX - midX) <= 140
    }

    private func isInsideExpandedZone(cgX: CGFloat, cgY: CGFloat) -> Bool {
        guard let screen = notchScreen(), cursorScreen() == screen else { return false }
        let midX = screen.frame.midX
        return cgY >= 0 && cgY <= 560 && abs(cgX - midX) <= 240
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
          window.__notchHost = 'http://localhost:3340';
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
        if let remote = URL(string: "http://localhost:3340/notch/orb/notch.html") {
            NotchLogger.shared.log("info", "[swift] loading orb from \(remote)")
            web.load(URLRequest(url: remote))
        } else if let url = Bundle.module.url(forResource: "notch", withExtension: "html", subdirectory: "Orb") {
            NotchLogger.shared.log("warn", "[swift] router URL invalid — fallback file:// \(url.path)")
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            NotchLogger.shared.log("error", "[swift] No orb URL available")
        }
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
    static let assistantSpeakingMaxDuration: TimeInterval = 60.0

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
        if let url = URL(string: "http://localhost:3340/api/notch/barge") {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.timeoutInterval = 1.0
            URLSession.shared.dataTask(with: req).resume()
        }
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
    /// 60ms collapse — gives the user 2.5s to come back without losing
    /// what they were saying. Cancelled if the cursor re-enters or if the
    /// recorder stops naturally on silence.
    private var hoverRecordGraceTask: Task<Void, Never>?
    private let hoverRecordGraceSeconds: Double = 2.5

    /// Hover-record master switch, mirrored to `~/.claude/jarvis/state/notch-prefs.json`
    /// via the router's `/api/notch/prefs`. OFF by default — hover is too
    /// trigger-happy a gesture to arm a mic automatically without user opt-in.
    @Published var hoverRecord: Bool = false

    /// Dwell timer: the user must hover CONTINUOUSLY for ~400 ms before the
    /// mic arms. Cancelled if the cursor leaves inside the window.
    private var armingTask: Task<Void, Never>?
    /// Epoch of the last streaming stop — used to enforce a post-stop cooldown
    /// so a cursor that immediately re-enters the zone doesn't re-arm before
    /// the user intends to.
    private var lastStreamStopAt: TimeInterval = 0
    /// Dwell delay & post-stop cooldown. Tuned for the hover-to-talk UX
    /// described in the phase plan — 400 ms is the sweet spot between
    /// "feels responsive" and "accidentally triggers while aiming menubar".
    private let hoverArmDelaySeconds: Double = 0.4
    private let hoverStopCooldownSeconds: Double = 0.8

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
        guard let url = URL(string: "http://localhost:3340/notch/orb/notch.html") else { return }
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
        if now - lastStreamStopAt < hoverStopCooldownSeconds { return }
        armingTask?.cancel()
        armingTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(400)))
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
        let graceMs = Int(hoverRecordGraceSeconds * 1000)
        evalJS("window.__notchVoiceGraceStart && window.__notchVoiceGraceStart(\(graceMs));")
        hoverRecordGraceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(self?.hoverRecordGraceSeconds ?? 2.5))
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
    /// `cornerWarnPx` we paint a red ring as a "you're about to abort" hint.
    private let cornerAbortPx: CGFloat = 80
    private let cornerWarnPx: CGFloat = 260
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
        // Proximity 0 (far) → 1 (at corner). Use cornerWarnPx as the start
        // of the visible engagement; below cornerAbortPx it's full-bleed red.
        let warn = cornerWarnPx
        let abort = cornerAbortPx
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
        guard let url = URL(string: "http://localhost:3340/api/notch/send"),
              let body = try? JSONSerialization.data(withJSONObject: ["text": text, "from": "notch-voice"]) else { return }
        var req = URLRequest(url: url)
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
        let voiced = clamped > 0.18
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
        guard let url = URL(string: "http://localhost:3340/api/notch/prefs"),
              let body = try? JSONSerialization.data(withJSONObject: patch) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        _ = try? await URLSession.shared.data(for: req)
    }

    /// One-shot prefs fetch at mount(). Best-effort; failures just leave us
    /// on the compiled-in defaults.
    private func loadPrefsFromRouter() {
        Task { @MainActor in
            guard let url = URL(string: "http://localhost:3340/api/notch/prefs") else { return }
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
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
        next[index] = min(1.0, next[index] + 0.75)
        channelLevels = next
        // Cancel any in-flight decay for this slot so a single decay loop
        // owns the channel until completion (or the next bump).
        let targetIndex = index
        channelDecayTasks[targetIndex]?.cancel()
        channelDecayTasks[targetIndex] = Task { @MainActor [weak self] in
            for _ in 0..<30 {
                try? await Task.sleep(for: .milliseconds(66))
                if Task.isCancelled { return }
                guard let self else { return }
                if self.channelLevels[targetIndex] <= 0 { return }
                var decayed = self.channelLevels
                decayed[targetIndex] = max(0, decayed[targetIndex] - 0.045)
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
        let width: CGFloat = min(440, f.width - 120)
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
                try? await Task.sleep(for: .seconds(5))
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
        if now - lastInterruptAt < 0.6 { return }
        lastInterruptAt = now
        NotchLogger.shared.log("info", "[interrupt] \(reason)")
        // 1. Local TTS via AVSpeechSynthesizer
        NotchSpeechSynthesizer.shared.stop()
        // 2. Server-side: cancel any in-flight assistant reply
        if let url = URL(string: "http://localhost:3340/api/notch/abort") {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.timeoutInterval = 3
            URLSession.shared.dataTask(with: req).resume()
        }
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

/// Compact-mode peek that reads as a downward extension of the system
/// notch. Drawn with a `NotchShape` silhouette (concave top corners that
/// curl into the notch curve, rounded bottom corners) and animated in
/// with a spring on transform.scale.y anchored at the top edge — same
/// pattern boring.notch / DynamicNotchKit use for their open animation.
final class MessagePeekView: NSView {
    private let label: NSTextField
    private let shape = CAShapeLayer()

    private var role: NotchController.PeekRole = .assistant

    /// Notch silhouette geometry. `topR` = small concave radius that
    /// matches the system notch's bottom-left/right curvature. `bottomR`
    /// = larger convex radius for a rounded pill bottom.
    private let topR: CGFloat = 8
    private let bottomR: CGFloat = 14

    override init(frame: NSRect) {
        let lbl = NSTextField(wrappingLabelWithString: "")
        lbl.font = .systemFont(ofSize: 12.5, weight: .regular)
        // No line cap — the peek panel grows vertically (extending the
        // black notch silhouette downward) so every message is fully
        // visible. Hard cap on the panel side via `preferredHeight`.
        lbl.maximumNumberOfLines = 0
        lbl.lineBreakMode = .byWordWrapping
        lbl.cell?.truncatesLastVisibleLine = false
        lbl.alignment = .center
        lbl.drawsBackground = false
        lbl.isBezeled = false
        lbl.isEditable = false
        lbl.isSelectable = false
        self.label = lbl

        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.masksToBounds = false
        // anchor=(0.5, 1) → the layer's y-scale grows DOWNWARD from the
        // top, so the panel "drops" out of the notch instead of inflating
        // from the centre.
        layer?.anchorPoint = CGPoint(x: 0.5, y: 1)

        shape.fillColor = NSColor(red: 0.03, green: 0.03, blue: 0.04, alpha: 0.96).cgColor
        layer?.addSublayer(shape)
        addSubview(lbl)
        applyRoleStyling()
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        // anchorPoint=(0.5,1) repositions the layer; counter-set position
        // so the visual rect still matches the panel bounds.
        layer?.frame = bounds
        layer?.position = CGPoint(x: bounds.midX, y: bounds.maxY)
        shape.frame = bounds
        shape.path = Self.notchExtensionPath(in: bounds, topR: topR, bottomR: bottomR)

        let inner: CGFloat = 18
        let textHeight = label.sizeThatFits(
            NSSize(width: bounds.width - inner * 2, height: .greatestFiniteMagnitude)
        ).height
        label.frame = NSRect(
            x: inner,
            y: (bounds.height - textHeight) / 2 - 1,
            width: bounds.width - inner * 2,
            height: textHeight
        )
        label.preferredMaxLayoutWidth = label.frame.width
    }

    func set(role: NotchController.PeekRole, text: String) {
        self.role = role
        label.stringValue = text
        applyRoleStyling()
        needsLayout = true
        layout()
    }

    func preferredHeight(forWidth width: CGFloat) -> CGFloat {
        let inner: CGFloat = 18
        let textWidth = width - inner * 2
        label.preferredMaxLayoutWidth = textWidth
        let h = label.sizeThatFits(NSSize(width: textWidth, height: .greatestFiniteMagnitude)).height
        // Min height matches the notch cutout so even a 1-line message
        // reads as a sibling of the system notch, not a thin sliver.
        // Max height ≈ 8 lines of body copy: keeps long replies / voice
        // transcripts fully visible (extending the notch downward in
        // black) without ever painting over half the screen.
        let raw = ceil(h) + 22
        return min(max(40, raw), 220)
    }

    /// Spring-down: layer starts squashed against the top edge (sy≈0.001)
    /// and springs to full height. Mirrors boring.notch's open spring
    /// (`response: 0.42, damping: 0.8`).
    func animateIn() {
        guard let l = layer else { return }
        let spring = CASpringAnimation(keyPath: "transform.scale.y")
        spring.fromValue = 0.001
        spring.toValue = 1.0
        spring.damping = 14
        spring.stiffness = 220
        spring.mass = 1
        spring.initialVelocity = 8
        spring.duration = spring.settlingDuration
        l.add(spring, forKey: "peek-in")
        l.transform = CATransform3DIdentity
    }

    func animateOut(completion: @escaping () -> Void) {
        guard let l = layer else { completion(); return }
        CATransaction.begin()
        CATransaction.setCompletionBlock(completion)
        let anim = CABasicAnimation(keyPath: "transform.scale.y")
        anim.fromValue = (l.presentation()?.value(forKeyPath: "transform.scale.y") as? CGFloat) ?? 1.0
        anim.toValue = 0.001
        anim.duration = 0.18
        anim.timingFunction = CAMediaTimingFunction(name: .easeIn)
        l.add(anim, forKey: "peek-out")
        l.transform = CATransform3DMakeScale(1, 0.001, 1)
        CATransaction.commit()
    }

    private func applyRoleStyling() {
        switch role {
        case .user:
            label.textColor = NSColor(red: 1.00, green: 0.78, blue: 0.40, alpha: 1)
        case .assistant:
            label.textColor = NSColor(white: 0.96, alpha: 1)
        }
    }

    /// NotchShape adapted from boring.notch (MIT) for AppKit's Y-up coords.
    /// Top corners (`topR`) curve INWARD to mate with the system notch's
    /// bottom curve; bottom corners (`bottomR`) round OUTWARD.
    static func notchExtensionPath(in rect: CGRect, topR: CGFloat, bottomR: CGFloat) -> CGPath {
        let path = CGMutablePath()
        let minX = rect.minX, maxX = rect.maxX
        let minY = rect.minY, maxY = rect.maxY
        path.move(to: CGPoint(x: minX, y: maxY))
        path.addQuadCurve(
            to: CGPoint(x: minX + topR, y: maxY - topR),
            control: CGPoint(x: minX + topR, y: maxY)
        )
        path.addLine(to: CGPoint(x: minX + topR, y: minY + bottomR))
        path.addQuadCurve(
            to: CGPoint(x: minX + topR + bottomR, y: minY),
            control: CGPoint(x: minX + topR, y: minY)
        )
        path.addLine(to: CGPoint(x: maxX - topR - bottomR, y: minY))
        path.addQuadCurve(
            to: CGPoint(x: maxX - topR, y: minY + bottomR),
            control: CGPoint(x: maxX - topR, y: minY)
        )
        path.addLine(to: CGPoint(x: maxX - topR, y: maxY - topR))
        path.addQuadCurve(
            to: CGPoint(x: maxX, y: maxY),
            control: CGPoint(x: maxX - topR, y: maxY)
        )
        path.closeSubpath()
        return path
    }
}

/// Voice-mode aura around the system notch cutout. Visible whenever
/// there's something cancellable (recording or agent active) — gives
/// the user a "Jarvis is listening / thinking" cue even when the notch
/// is collapsed and the orb glow alone is too subtle.
@MainActor
final class NotchAuraView: NSView {
    private let halo = CAShapeLayer()
    var notchHeight: CGFloat = 38 { didSet { needsLayout = true } }
    private var isActive: Bool = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.masksToBounds = false

        // Halo: a stroked NotchShape with a large soft shadow that bleeds
        // OUT around the cutout silhouette. The stroke itself is mostly
        // transparent — the visual is dominated by the layer shadow.
        halo.fillColor = NSColor.clear.cgColor
        halo.strokeColor = NSColor(red: 1.00, green: 0.74, blue: 0.32, alpha: 0.85).cgColor
        halo.lineWidth = 1.5
        halo.shadowColor = NSColor(red: 1.00, green: 0.74, blue: 0.32, alpha: 1).cgColor
        halo.shadowOpacity = 0.85
        halo.shadowRadius = 18
        halo.shadowOffset = .zero
        layer?.addSublayer(halo)
        layer?.opacity = 0
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        // The notch cutout sits at the TOP of our panel, centred.
        // We draw a NotchShape silhouette for the cutout (~200×notchH)
        // and let the shadow bleed out into the surrounding area.
        let notchW: CGFloat = 200
        let notchRect = CGRect(
            x: bounds.midX - notchW / 2,
            y: bounds.maxY - notchHeight,
            width: notchW,
            height: notchHeight
        )
        halo.path = MessagePeekView.notchExtensionPath(in: notchRect, topR: 8, bottomR: 12)
        halo.frame = bounds
    }

    func setActive(_ active: Bool) {
        guard active != isActive else { return }
        isActive = active
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.fromValue = layer?.opacity
        anim.toValue = active ? 1 : 0
        anim.duration = 0.28
        layer?.add(anim, forKey: "active")
        layer?.opacity = active ? 1 : 0
        if active { startBreathing() } else { halo.removeAnimation(forKey: "breath") }
    }

    private func startBreathing() {
        if halo.animation(forKey: "breath") != nil { return }
        let b = CABasicAnimation(keyPath: "shadowRadius")
        b.fromValue = 14
        b.toValue = 22
        b.duration = 1.4
        b.autoreverses = true
        b.repeatCount = .infinity
        b.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        halo.add(b, forKey: "breath")
    }
}

// MARK: - CGEvent tap (physical notch cutout → expand)

/// Low-level event tap that receives every left-mouse-down on the system,
/// including clicks in the MacBook notch cutout area — where no NSPanel
/// ever gets mouseDown because macOS treats those pixels as a hardware
/// dead zone. Requires Accessibility permission (prompted on first launch).
///
/// CG coordinates: origin is TOP-LEFT, Y grows DOWN. That's opposite of
/// NSEvent.mouseLocation, so we check `y <= 36` (top strip).
@MainActor
final class NotchEventTap {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    /// Called for EVERY left-mouse-down observed by the tap. The boolean
    /// argument tells the controller whether the click landed inside the
    /// notch hit zone, so it can decide to expand / collapse accordingly.
    private let onNotchClick: (Bool) -> Void
    init(onNotchClick: @escaping (Bool) -> Void) {
        self.onNotchClick = onNotchClick
        install()
    }

    deinit {
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source = source {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
        }
    }

    private func install() {
        // Listen for mouseDown PLUS the two "tap got disabled" meta-events —
        // macOS throws those when the tap callback takes too long (timeout)
        // or when the user triggers something that forces a reset. We MUST
        // re-enable in that case, otherwise the tap goes silent forever.
        // Only listen for clicks here — mouseMoved is handled by
        // NSEvent.addGlobalMonitorForEvents in the controller. Piping the
        // mouseMoved firehose through a CGEvent tap starves the main actor
        // and causes macOS to disable the tap with tapDisabledByTimeout on
        // every click. Keeping the tap click-only eliminates that churn.
        let mask: CGEventMask =
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.tapDisabledByTimeout.rawValue) |
            (1 << CGEventType.tapDisabledByUserInput.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            guard let userInfo else { return Unmanaged.passUnretained(event) }
            let me = Unmanaged<NotchEventTap>.fromOpaque(userInfo).takeUnretainedValue()

            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                Task { @MainActor in
                    NotchLogger.shared.log("warn", "[tap] disabled (\(type.rawValue)) — re-enabling")
                    if let tap = me.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                }
                return Unmanaged.passUnretained(event)
            }

            if type == .leftMouseDown {
                let loc = event.location
                Task { @MainActor in
                    let notchScreen = NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main
                    guard let screen = notchScreen else { return }
                    let midX = screen.frame.midX
                    let nearTop = loc.y <= 40
                    let nearCenter = abs(loc.x - midX) <= 140
                    NotchLogger.shared.log("info",
                        "[tap] click cg=(\(Int(loc.x)),\(Int(loc.y))) inside=\(nearTop && nearCenter)")
                    me.onNotchClick(nearTop && nearCenter)
                }
            }
            return Unmanaged.passUnretained(event)
        }

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            NotchLogger.shared.log("warn", "[tap] CGEvent.tapCreate returned nil — Accessibility permission needed")
            requestAccessibilityPermission()
            return
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        NotchLogger.shared.log("info", "[tap] CGEvent tap installed")
    }

    private func requestAccessibilityPermission() {
        // Present the system Accessibility prompt so the user can grant
        // us permission without digging into System Settings manually.
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as NSString
        let options: NSDictionary = [key: true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
    }
}

// MARK: - Compact views

struct NotchCompactLeading: View {
    @ObservedObject var controller: NotchController
    var body: some View {
        ZStack {
            // Full-area glow so when state != idle the warm light fills the
            // notch instead of being clipped to a tiny square shadow around
            // a 10×10 dot. Painted as a radial gradient on the leading half
            // (NotchCompactTrailing paints the trailing half) — together
            // they tint the entire pill.
            NotchGlowFill(state: controller.state, side: .leading)
            HStack(spacing: 0) {
                NotchDot(active: controller.state != .idle)
                    .frame(width: 10, height: 10)
                    .padding(.leading, 6)
                Color.clear.frame(maxWidth: .infinity, minHeight: 24)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { controller.expandWithFocus(.chat) }
    }
}

/// Empty trailing — the native notch now shows a single compact icon,
/// matching the dashboard mirror. The leading slot owns the whole compact
/// interaction; the trailing side just takes clicks so the whole pill still
/// feels tappable.
struct NotchCompactTrailing: View {
    @ObservedObject var controller: NotchController
    var body: some View {
        NotchGlowFill(state: controller.state, side: .trailing)
            .frame(maxWidth: .infinity, minHeight: 24)
            .contentShape(Rectangle())
            .onTapGesture { controller.expandWithFocus(.chat) }
    }
}

/// Radial-gradient fill that tints the whole compact slot with a state-aware
/// glow. Idle = transparent. Thinking = warm orange. Responding = cool white.
/// The gradient is anchored toward the notch cutout so leading + trailing
/// halves visually merge into one continuous halo around the cutout instead
/// of two squared boxes.
struct NotchGlowFill: View {
    enum Side { case leading, trailing }
    let state: NotchAgentState
    let side: Side

    private var color: Color? {
        switch state {
        case .idle: return nil
        case .thinking: return Color(red: 1.00, green: 0.65, blue: 0.20)
        case .responding: return Color(red: 0.78, green: 0.88, blue: 1.00)
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let breath: Double = state == .idle ? 0 : 0.55 + 0.25 * (0.5 + 0.5 * sin(t * 2.4))
            Canvas { ctx, size in
                guard let c = color else { return }
                let rect = CGRect(origin: .zero, size: size)
                // Anchor toward the side that touches the cutout — leading
                // glow originates from its right edge, trailing from its
                // left, so the two halves merge seamlessly across the notch.
                let anchor = CGPoint(
                    x: side == .leading ? rect.maxX : rect.minX,
                    y: rect.midY
                )
                let r = max(rect.width, rect.height) * 1.4
                let grad = Gradient(stops: [
                    .init(color: c.opacity(0.95 * breath), location: 0.0),
                    .init(color: c.opacity(0.55 * breath), location: 0.25),
                    .init(color: c.opacity(0.20 * breath), location: 0.55),
                    .init(color: c.opacity(0.0),           location: 1.0),
                ])
                ctx.fill(
                    Path(rect),
                    with: .radialGradient(grad, center: anchor, startRadius: 0, endRadius: r)
                )
            }
            .allowsHitTesting(false)
        }
    }
}

/// Small glowing circle used as the unified compact indicator. Pulses
/// subtly when the agent is doing something (thinking / responding).
struct NotchDot: View {
    let active: Bool
    @State private var pulse: Double = 0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let breathe = active ? 0.6 + 0.4 * (0.5 + 0.5 * sin(t * 3.0)) : 0.85
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(red: 1.00, green: 0.78, blue: 0.40),
                            Color(red: 1.00, green: 0.55, blue: 0.20),
                        ],
                        center: .init(x: 0.35, y: 0.35),
                        startRadius: 0.5,
                        endRadius: 6
                    )
                )
                .shadow(color: Color(red: 1.00, green: 0.70, blue: 0.30).opacity(breathe), radius: 4)
        }
    }
}

// MARK: - Expanded view

struct NotchExpandedView: View {
    @ObservedObject var controller: NotchController

    var body: some View {
        SharedWebContainer(webView: controller.webView)
            .frame(width: 420, height: 540)
            .background(.clear)
            .cornerRadius(22)
    }
}

/// NSViewRepresentable that re-parents the SHARED WKWebView into the
/// container the moment the expanded view appears. No re-init, no black
/// flash: the WebGL context was already warm inside the preload window.
struct SharedWebContainer: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.clear.cgColor
        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        if webView.superview !== nsView {
            webView.removeFromSuperview()
            nsView.addSubview(webView)
        }
        webView.frame = nsView.bounds
        webView.autoresizingMask = [.width, .height]
    }
}

// MARK: - Agent state model

enum NotchAgentState: String {
    case idle
    case thinking
    case responding
}

enum NotchEvent {
    case stateChange(NotchAgentState)
    case messageIn(String)
    case messageOut(String, String)
    case messageChunk(String)
    case toolRunning(String)
    case agentMeta(String)
    case ttsSpeak(String, String?)  // text, voice identifier (optional)
    case ttsStop
}

// MARK: - Event bus (SSE client to /api/notch/stream)

@MainActor
final class NotchEventBus {
    static let shared = NotchEventBus()

    private let url = URL(string: "http://localhost:3340/api/notch/stream")!
    /// Active SSE session. Created fresh per connect() because URLSession
    /// strongly retains its delegate until `invalidateAndCancel()` is called
    /// — without that, every reconnect would leak a session + its SSEDelegate.
    private var currentSession: URLSession?
    private var task: URLSessionDataTask?
    private var delegate: SSEDelegate?
    private var handler: ((NotchEvent) -> Void)?
    private var backoff: TimeInterval = 0.5

    func start(_ handler: @escaping (NotchEvent) -> Void) {
        self.handler = handler
        connect()
    }

    private func connect() {
        // Tear down the previous session BEFORE allocating a new one. The
        // task `cancel()` alone is not enough — the URLSession still retains
        // its delegate, and the delegate retains the closures, leaking on
        // every reconnect (router restart, network flap).
        currentSession?.invalidateAndCancel()
        currentSession = nil
        task?.cancel()
        task = nil
        let delegate = SSEDelegate { [weak self] line in
            Task { @MainActor in self?.parse(line: line) }
        } onClose: { [weak self] in
            Task { @MainActor in self?.scheduleReconnect() }
        }
        self.delegate = delegate
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        currentSession = session
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 0  // keep open forever
        let t = session.dataTask(with: req)
        task = t
        t.resume()
    }

    private func scheduleReconnect() {
        let delay = backoff
        backoff = min(backoff * 1.6, 10)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            connect()
        }
    }

    private func parse(line: String) {
        // SSE "data: {json}" framing. Ignore comments and empty.
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("data:") else { return }
        let json = trimmed.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
        guard
            let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = obj["type"] as? String
        else { return }
        let d = (obj["data"] as? [String: Any]) ?? [:]

        backoff = 0.5 // reset on any successful event

        switch type {
        case "state.change":
            let s = d["state"] as? String ?? "idle"
            let parsed = NotchAgentState(rawValue: s) ?? .idle
            handler?(.stateChange(parsed))
        case "message.in":
            handler?(.messageIn(d["text"] as? String ?? ""))
        case "message.out":
            handler?(.messageOut(d["text"] as? String ?? "", d["from"] as? String ?? ""))
        case "message.chunk":
            handler?(.messageChunk(d["text"] as? String ?? ""))
        case "tool.running":
            handler?(.toolRunning(d["tool"] as? String ?? ""))
        case "agent-meta":
            handler?(.agentMeta(d["text"] as? String ?? ""))
        case "tts.speak":
            handler?(.ttsSpeak(d["text"] as? String ?? "", d["voice"] as? String))
        case "tts.stop":
            handler?(.ttsStop)
        default:
            break
        }
    }
}

/// URLSessionDataDelegate that accumulates a byte buffer and splits into SSE
/// lines terminated by "\n\n" blocks. Each non-empty "data:" line triggers
/// onLine. We split naively by "\n" here because the router emits single-line
/// `data:` events; multi-line payloads would need folding logic.
final class SSEDelegate: NSObject, URLSessionDataDelegate {
    private let onLine: (String) -> Void
    private let onClose: () -> Void
    private var buffer = Data()

    init(onLine: @escaping (String) -> Void, onClose: @escaping () -> Void) {
        self.onLine = onLine
        self.onClose = onClose
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let slice = buffer[..<nl]
            let line = String(data: slice, encoding: .utf8) ?? ""
            buffer.removeSubrange(buffer.startIndex...nl)
            if !line.isEmpty { onLine(line) }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onClose()
    }
}

// MARK: - JS bridge

/// Receives messageHandlers.jarvis.postMessage({type: …}) calls from the
/// webview. Handles `{type: 'collapse'}` (Escape key) and `{type: 'log', …}`
/// (console + error forwarding for the debug channel).
final class NotchWebBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let onCollapse: () -> Void
    let onLog: (String, String) -> Void
    let onVoiceStart: () -> Void
    let onVoiceStop: () -> Void
    let onInputChange: (Bool) -> Void
    let onHoverRecordToggle: (Bool) -> Void
    init(
        onCollapse: @escaping () -> Void,
        onLog: @escaping (String, String) -> Void,
        onVoiceStart: @escaping () -> Void,
        onVoiceStop: @escaping () -> Void,
        onInputChange: @escaping (Bool) -> Void,
        onHoverRecordToggle: @escaping (Bool) -> Void
    ) {
        self.onCollapse = onCollapse
        self.onLog = onLog
        self.onVoiceStart = onVoiceStart
        self.onVoiceStop = onVoiceStop
        self.onInputChange = onInputChange
        self.onHoverRecordToggle = onHoverRecordToggle
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "collapse":
            Task { @MainActor in self.onCollapse() }
        case "log":
            let level = (body["level"] as? String) ?? "log"
            let text = (body["text"] as? String) ?? ""
            onLog(level, text)
        case "voiceStart":
            Task { @MainActor in self.onVoiceStart() }
        case "voiceStop":
            Task { @MainActor in self.onVoiceStop() }
        case "inputChange":
            let hasText = (body["hasText"] as? Bool) ?? false
            Task { @MainActor in self.onInputChange(hasText) }
        case "setHoverRecord":
            let on = (body["on"] as? Bool) ?? false
            Task { @MainActor in self.onHoverRecordToggle(on) }
        case "audioLifecycle":
            // JS reports `audio` element start/end so the Swift side can
            // suppress STT during TTS playback (barge-in protection).
            let phase = (body["phase"] as? String) ?? ""
            Task { @MainActor in
                NotchController.shared.setAssistantSpeaking(phase == "start")
                let isStart = (phase == "start")
                NotchController.shared.assistantAudioPlaying = isStart
                NotchLogger.shared.log("info", "[audioLifecycle] \(phase)")
                // Safety auto-reset: if 'end' never arrives, force-clear after
                // 60s. Otherwise stuck flag locks out future logic that reads it.
                NotchController.shared.assistantSpeakingResetTimer?.invalidate()
                if isStart {
                    NotchController.shared.assistantSpeakingResetTimer = Timer.scheduledTimer(
                        withTimeInterval: NotchController.assistantSpeakingMaxDuration,
                        repeats: false
                    ) { _ in
                        Task { @MainActor in
                            if NotchController.shared.assistantAudioPlaying {
                                NotchLogger.shared.log("warn", "[audioLifecycle] safety auto-reset — 'end' never arrived")
                                NotchController.shared.assistantAudioPlaying = false
                                NotchController.shared.setAssistantSpeaking(false)
                            }
                        }
                    }
                } else {
                    NotchController.shared.assistantSpeakingResetTimer = nil
                }
            }
        case "voicePartial":
            // Live SFSpeechRecognizer transcript while the user is talking.
            // Mirror it under the system notch as a peek panel so the
            // words remain visible even while the chat log is offscreen
            // (compact mode) or behind the orb (expanded). Empty text →
            // dismiss any active peek (end-of-utterance signal from JS).
            let text = (body["text"] as? String) ?? ""
            Task { @MainActor in
                if text.isEmpty {
                    NotchController.shared.dismissPeek()
                } else if !NotchController.shared.isExpanded {
                    NotchController.shared.showMessagePeek(role: .user, text: text)
                }
            }
        case "vad.speechStart":
            // Silero VAD ha rilevato l'inizio del parlato dell'utente.
            // Se il TTS sta playing → barge-in: stop AVSpeech locale +
            // notify il router (via /api/notch/barge) per cancellare la
            // riga in-flight + emettere audio.stop al WebView.
            // Se nessun TTS attivo → semplice "user is speaking" hint
            // per accelerare lo state.change.
            Task { @MainActor in
                NotchController.shared.handleVADSpeechStart()
            }
        case "vad.speechEnd":
            // Silero ha rilevato la fine dell'utterance — accelera il flush
            // dello StreamingRecorder, bypassando il suo silence-detection
            // RMS-based che ha threshold 1.5s. UX più snappy.
            Task { @MainActor in
                NotchController.shared.handleVADSpeechEnd()
            }
        case "vad.ready", "vad.paused", "vad.resumed", "vad.stopped":
            NotchLogger.shared.log("debug", "[vad] state=\(type)")
        case "vad.error":
            let msg = (body["data"] as? [String: Any])?["message"] as? String ?? "?"
            NotchLogger.shared.log("warn", "[vad] error: \(msg)")
        default:
            break
        }
    }

    // MARK: WKNavigationDelegate — log everything that happens.

    func webView(_ w: WKWebView, didStartProvisionalNavigation nav: WKNavigation!) {
        onLog("info", "[nav] didStart \(w.url?.absoluteString ?? "?")")
    }
    func webView(_ w: WKWebView, didCommit nav: WKNavigation!) {
        onLog("info", "[nav] didCommit \(w.url?.absoluteString ?? "?")")
    }
    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        onLog("info", "[nav] didFinish \(w.url?.absoluteString ?? "?")")
    }
    func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError error: Error) {
        onLog("error", "[nav] didFail \(error.localizedDescription)")
        scheduleReload(w, delay: 1.5, reason: "didFail")
    }
    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        onLog("error", "[nav] didFailProvisional \(error.localizedDescription)")
        scheduleReload(w, delay: 1.5, reason: "didFailProvisional")
    }

    /// WebKit kills the WebContent process under memory/GPU pressure, after
    /// long sleeps, and occasionally after display-config changes. The
    /// previous stub here had the wrong selector signature — WebKit silently
    /// never invoked it, so the WebView stayed blank ("notch nero") until
    /// the user relaunched the app. Reload immediately to recover.
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
        onLog("error", "[nav] webContent process terminated — reloading")
        scheduleReload(w, delay: 0.0, reason: "processTerminated")
    }

    private func scheduleReload(_ w: WKWebView, delay: TimeInterval, reason: String) {
        Task { @MainActor in
            if delay > 0 { try? await Task.sleep(for: .milliseconds(Int(delay * 1000))) }
            // Prefer reloading the original URL — `reload()` is a no-op when
            // the previous load never committed (e.g. router was down at
            // boot), which is exactly the case we need to recover from.
            if let remote = URL(string: "http://localhost:3340/notch/orb/notch.html") {
                self.onLog("info", "[nav] reload (\(reason)) → \(remote)")
                w.load(URLRequest(url: remote))
            } else {
                w.reload()
            }
        }
    }
}

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
