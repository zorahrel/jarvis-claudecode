import XCTest
@testable import JarvisNotch

/// (W3 FIX) ORC-14 — reconnect-state preservation.
///
/// Contract: when the notch transport disconnects + reconnects, the
/// view-model retains the last sessions/todos state. NotchEventBus.shared
/// exposes a last-known-snapshot cache that downstream views can re-read on
/// reconnect (so the views never go perma-empty after a router restart or
/// network flap).
///
/// RED at Wave 0 — `publishForTesting`, `simulateDisconnectForTesting`,
/// `simulateReconnectForTesting`, and `lastSessionsForTesting` do not exist
/// yet on `NotchEventBus`. Turns GREEN after Task 2 lands them inside an
/// `#if DEBUG` block (so production API stays clean).
final class NotchEventBusReconnectTests: XCTestCase {
    @MainActor
    func testReconnectReplaysLastSnapshot() async throws {
        let payload = SessionsUpdatePayload(
            pids: [1, 2],
            ts: 0,
            sessions: [
                .init(pid: 1, repo: "a", status: "working", conflict: nil),
                .init(pid: 2, repo: "b", status: "idle", conflict: nil),
            ]
        )
        // Step 1: emit a snapshot so the bus caches it.
        NotchEventBus.shared.publishForTesting(.sessionsUpdate(payload))

        // Step 2: simulate disconnect + reconnect — the cache must survive.
        NotchEventBus.shared.simulateDisconnectForTesting()
        NotchEventBus.shared.simulateReconnectForTesting()

        // Step 3: assert the last-known sessions state is still queryable.
        let cached = NotchEventBus.shared.lastSessionsForTesting()
        XCTAssertEqual(cached?.pids, [1, 2])
        XCTAssertEqual(cached?.sessions?.count, 2)
        XCTAssertEqual(cached?.sessions?.first?.repo, "a")
    }
}
