import Foundation

// MARK: - Event bus (SSE client to /api/notch/stream)

/// Long-lived SSE client that forwards router events into typed
/// `NotchEvent` values for the controller. Singleton (mounted once at
/// app launch by `NotchController.mount`).
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
    private var handler: ((NotchEvent) -> Void)?
    private var backoff: TimeInterval = NotchTuning.sseBackoffStart

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
        backoff = min(backoff * NotchTuning.sseBackoffFactor, NotchTuning.sseBackoffMax)
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
