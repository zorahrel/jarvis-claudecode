import Foundation

/// Centralized router endpoints. All HTTP calls from the notch process go
/// through localhost:3340 — single source so we don't grep 8 files when the
/// router moves (or when we wire a JARVIS_ROUTER_URL env var).
enum NotchEndpoints {
    /// Base origin of the Jarvis router. Override via `JARVIS_NOTCH_HOST` env
    /// var (useful for dev with a router on a different port).
    static let host: String = {
        ProcessInfo.processInfo.environment["JARVIS_NOTCH_HOST"]
            ?? "http://localhost:3340"
    }()

    static var orbHTML: URL { URL(string: "\(host)/notch/orb/notch.html")! }
    static var sseStream: URL { URL(string: "\(host)/api/notch/stream")! }
    static var send: URL { URL(string: "\(host)/api/notch/send")! }
    static var prefs: URL { URL(string: "\(host)/api/notch/prefs")! }
    static var barge: URL { URL(string: "\(host)/api/notch/barge")! }
    static var abort: URL { URL(string: "\(host)/api/notch/abort")! }
}

/// All animation durations, debounce thresholds, and "magic" numbers driving
/// the notch's perceived personality. Grouped so changing the feel of the
/// surface (snappier vs softer) doesn't require grepping the controller.
///
/// Convention: durations in seconds (TimeInterval), pixel distances in
/// CGFloat, RMS thresholds in Float (matching their consumers' types).
enum NotchTuning {
    // MARK: - Hover engine

    /// Throttle for the high-frequency `mouseMoved` global monitor. 60Hz
    /// matches the display refresh; 33ms (30Hz) was the previous value but
    /// produced visible "stutter" on the corner-warn pulse during fast
    /// approaches.
    static let hoverThrottleSeconds: TimeInterval = 1.0 / 60.0

    /// Dwell time before the hover-record arming actually starts capture.
    /// Long enough to filter cursor flybys, short enough to feel instant
    /// when the user dwells intentionally.
    static let hoverArmDelaySeconds: TimeInterval = 0.4

    /// Grace window after mouse-out: the recorder keeps capturing while we
    /// wait this long for the cursor to come back. Ends the call on expiry.
    static let hoverRecordGraceSeconds: TimeInterval = 2.5

    /// Cooldown after stopping a recorder before a fresh hover can re-arm.
    /// Prevents rapid hover bouncing from spamming whisper-cli on the server.
    static let hoverStopCooldownSeconds: TimeInterval = 0.8

    /// Pending-collapse delay on mouse-out (when not recording). Gives the
    /// user 60ms to come back without losing the expanded panel.
    static let pendingCollapseSeconds: TimeInterval = 0.06

    // MARK: - Compact / expanded hit zones (CG coordinates, top-down Y)

    /// Vertical extent of the compact hit zone (Y ≤ this value).
    static let compactZoneMaxY: CGFloat = 40

    /// Horizontal half-width of the compact hit zone around screen midX.
    static let compactZoneHalfWidth: CGFloat = 140

    /// Vertical extent of the expanded hit zone (panel + breathing).
    static let expandedZoneMaxY: CGFloat = 560

    /// Horizontal half-width of the expanded hit zone.
    static let expandedZoneHalfWidth: CGFloat = 240

    // MARK: - Cancel affordance (corner gesture)

    /// Distance from the bottom-right corner where releasing aborts the
    /// in-flight call.
    static let cornerAbortPx: CGFloat = 80

    /// Distance where we begin painting the warning ring.
    static let cornerWarnPx: CGFloat = 260

    // MARK: - Interrupt / barge-in

    /// Minimum gap between successive `interruptJarvis` calls (debounce so
    /// repeated corner snaps don't spam the abort endpoint).
    static let interruptCooldownSeconds: TimeInterval = 0.6

    // MARK: - Peek bubble

    /// Auto-dismiss timeout for the standard message peek (assistant/user
    /// echo). The live-transcript peek bypasses this and is dismissed
    /// explicitly by the voice coordinator.
    static let peekAutoDismissSeconds: TimeInterval = 5

    /// Max width of the peek panel; the panel will clamp to this or to
    /// `screen.width - 120`, whichever is smaller.
    static let peekMaxWidth: CGFloat = 440

    // MARK: - Voice / TTS safety

    /// Hard limit for the `assistantSpeaking` flag if the WebView audio
    /// `lifecycle:end` event never fires (network drop, MP3 truncation).
    /// Without this, a stuck flag would block hover-arm decisions
    /// indefinitely. Long utterances rarely exceed 30s, 60 gives margin.
    static let assistantSpeakingMaxDuration: TimeInterval = 60

    /// SSE reconnect backoff: starts here, multiplied by `sseBackoffFactor`
    /// each failure, capped at `sseBackoffMax`.
    static let sseBackoffStart: TimeInterval = 0.5
    static let sseBackoffFactor: TimeInterval = 1.6
    static let sseBackoffMax: TimeInterval = 10

    // MARK: - Streaming recorder

    /// RMS threshold (after the 8× scaling in pushPartialLevel) above which
    /// we emit `voiceVoiced` to swap the aura colour. Matches StreamingRecorder
    /// silence threshold × ~3.
    static let voicedRmsThreshold: Float = 0.18

    // MARK: - Channel bar decay (NotchController.bumpChannel)

    /// Decay step per tick (66ms tick), so a full bar empties in ~30 ticks
    /// = ~2 seconds.
    static let channelDecayStep: Double = 0.045

    /// Decay tick interval.
    static let channelDecayTickMs: Int = 66

    /// Boost per bumpChannel call (clamped to 1.0).
    static let channelBumpBoost: Double = 0.75
}
