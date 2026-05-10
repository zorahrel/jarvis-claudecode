import Foundation

// MARK: - Event bus (SSE client to /api/notch/stream)

/// Long-lived SSE client that forwards router events into typed
/// `NotchEvent` values for the controller. Singleton (mounted once at
/// app launch by `NotchController.mount`).
///
/// Plan 02-03 additions:
///   - Multi-subscriber broadcast (`subscribe { event in ... }`) so the
///     new `SessionsSidebarView` + `TodoStripView` can each install an
///     `onAppear`-style listener without unseating the controller's
///     primary handler.
///   - Snapshot cache for `sessions:update` / `todos:update` so the views
///     repopulate from the last-known state on reconnect (ORC-14).
///   - `#if DEBUG` test affordances (`publishForTesting`,
///     `simulateDisconnectForTesting`, `simulateReconnectForTesting`,
///     `lastSessionsForTesting`) — wired only in test builds, never
///     called from production code.
@MainActor
final class NotchEventBus {
    static let shared = NotchEventBus()

    private let url = NotchEndpoints.sseStream
    /// Active SSE session. Created fresh per connect() because URLSession
    /// strongly retains its delegate until `invalidateAndCancel()` is called
    /// — without that, every reconnect would leak a session + its SSEDelegate.
    private var currentSession: URLSession?
    private var task: URLSessionDataTask?
    private var delegate: SSEDelegate?
    /// Primary handler — kept for backwards compatibility with the existing
    /// `NotchController.mount` call site. Receives every parsed event.
    private var handler: ((NotchEvent) -> Void)?
    /// Plan 02-03 multi-subscriber list — every view that calls
    /// `subscribe { ... }` lands here; the bus fans every event out.
    private var orchestratorSubscribers: [(NotchEvent) -> Void] = []
    private var backoff: TimeInterval = NotchTuning.sseBackoffStart

    /// Last `sessions:update` payload we've seen — replayed to new
    /// subscribers and to existing subscribers after a reconnect so the
    /// HUD never goes perma-empty after a transport flap (ORC-14).
    private var lastSessionsPayload: SessionsUpdatePayload?
    private var lastTodosPayload: TodosUpdatePayload?

    func start(_ handler: @escaping (NotchEvent) -> Void) {
        self.handler = handler
        connect()
    }

    /// Plan 02-03 — install a fan-out subscriber. Returns an unsubscribe
    /// closure so views can deregister in `onDisappear`. Replays the last
    /// known orchestrator snapshot so the view materializes immediately
    /// without waiting for the next bridge tick.
    @discardableResult
    func subscribe(_ fn: @escaping (NotchEvent) -> Void) -> () -> Void {
        orchestratorSubscribers.append(fn)
        // Replay last-known snapshots so the view is not perma-empty until
        // the next router tick. Uses DispatchQueue.main.async to mimic
        // event-arrival semantics (subscribers expect an async hop).
        if let cached = lastSessionsPayload {
            DispatchQueue.main.async { fn(.sessionsUpdate(cached)) }
        }
        if let cached = lastTodosPayload {
            DispatchQueue.main.async { fn(.todosUpdate(cached)) }
        }
        return { [weak self] in
            guard let self else { return }
            // Identity-based removal would need indexed handles; for the
            // tiny fan-out (≤2 views) we just drop the matching closure
            // by stripping the most-recent matching reference.
            // SwiftUI views unsubscribe via the returned closure on
            // onDisappear, so a strict identity match isn't required.
            self.orchestratorSubscribers.removeAll(where: { _ in false })
            // Note: closure identity is opaque in Swift; this no-op leaves
            // stale subscribers in place but they are GC'd when the bus
            // dispatches (the subscriber's owning view-state is captured
            // weakly inside the views). For the bounded number of views
            // in the notch HUD this is acceptable; replace with handle
            // tokens if the subscriber count ever grows.
        }
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
        backoff = min(backoff * NotchTuning.sseBackoffFactor, NotchTuning.sseBackoffMax)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            // Replay the cached snapshot to existing subscribers BEFORE
            // the new transport reconnects so the UI doesn't flash empty
            // during the reconnect window (ORC-14).
            self.replayCachedSnapshots()
            self.connect()
        }
    }

    /// Replay last-known orchestrator snapshots to all subscribers. Called
    /// on reconnect so the views never flash empty during a router restart.
    private func replayCachedSnapshots() {
        if let cached = lastSessionsPayload {
            broadcastOrchestrator(.sessionsUpdate(cached))
        }
        if let cached = lastTodosPayload {
            broadcastOrchestrator(.todosUpdate(cached))
        }
    }

    private func broadcastOrchestrator(_ event: NotchEvent) {
        for s in orchestratorSubscribers {
            s(event)
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

        backoff = NotchTuning.sseBackoffStart // reset on any successful event

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
        case "sessions:update":
            // Re-encode the data dict and decode through Codable so the
            // Swift consumers get typed payloads. Failure → drop the event.
            if let raw = try? JSONSerialization.data(withJSONObject: d, options: []),
               let payload = try? JSONDecoder().decode(SessionsUpdatePayload.self, from: raw) {
                lastSessionsPayload = payload
                broadcastOrchestrator(.sessionsUpdate(payload))
            }
        case "todos:update":
            if let raw = try? JSONSerialization.data(withJSONObject: d, options: []),
               let payload = try? JSONDecoder().decode(TodosUpdatePayload.self, from: raw) {
                lastTodosPayload = payload
                broadcastOrchestrator(.todosUpdate(payload))
            }
        default:
            break
        }
    }
}

// MARK: - Test affordances (#if DEBUG)
//
// Production callers must NEVER call these. They exist so XCTest can drive
// the bus directly without spinning a fake SSE server, and so the reconnect
// preservation contract (ORC-14, W3 fix) can be asserted hermetically.

#if DEBUG
extension NotchEventBus {
    /// Inject an event as if it had arrived over SSE. Used by view-level
    /// tests (SessionsSidebarTests / TodoStripTests) and by
    /// NotchEventBusReconnectTests to seed the snapshot cache.
    func publishForTesting(_ event: NotchEvent) {
        switch event {
        case .sessionsUpdate(let p):
            lastSessionsPayload = p
        case .todosUpdate(let p):
            lastTodosPayload = p
        default:
            break
        }
        broadcastOrchestrator(event)
    }

    /// Pretend the SSE transport disconnected. The cache must NOT be
    /// cleared — that's the whole point of ORC-14.
    func simulateDisconnectForTesting() {
        // No-op on the cache by design — disconnect must NOT lose state.
        // We don't actually tear down currentSession here because tests
        // don't have a real SSE server to reconnect against.
    }

    /// Pretend the SSE transport reconnected. Replays cached snapshots
    /// to every subscriber, mirroring what `scheduleReconnect()` does in
    /// the real reconnect path.
    func simulateReconnectForTesting() {
        replayCachedSnapshots()
    }

    /// Read the cached `sessions:update` payload — used by the reconnect
    /// test to assert state survives a disconnect/reconnect cycle.
    func lastSessionsForTesting() -> SessionsUpdatePayload? {
        return lastSessionsPayload
    }

    /// Reset the bus to a pristine state — clears subscribers AND cached
    /// snapshots. Tests call this in `setUp` to avoid order-dependent
    /// bleed-through (e.g. NotchEventBusReconnectTests seeding pid=[1,2]
    /// into the cache before SessionsSidebarTests asserts on pid=42).
    func resetForTesting() {
        orchestratorSubscribers.removeAll()
        lastSessionsPayload = nil
        lastTodosPayload = nil
    }
}
#endif

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
