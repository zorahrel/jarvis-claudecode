import XCTest
import SwiftUI
@testable import JarvisNotch

/// ORC-11 — SessionsSidebarView: smoke render + reactivity to `sessions:update`.
///
/// RED at Wave 0 (the view + `SessionStatusEntry` + `publishForTesting` do
/// not exist yet). Turns GREEN when Task 2 lands the view + the test
/// affordance on `NotchEventBus`.
final class SessionsSidebarTests: XCTestCase {
    @MainActor
    func testRendersEmptyState() {
        let view = SessionsSidebarView(sessions: .constant([]))
        // Smoke: building the body must not crash on an empty array.
        _ = view.body
    }

    @MainActor
    func testRendersThreeSessionsWithStatusBadges() {
        let sessions: [SessionStatusEntry] = [
            .init(pid: 1, repo: "a", status: "awaiting_user_input", conflict: nil),
            .init(pid: 2, repo: "b", status: "tool_pending", conflict: nil),
            .init(pid: 3, repo: "c", status: "idle", conflict: nil),
        ]
        let view = SessionsSidebarView(sessions: .constant(sessions))
        _ = view.body
    }

    @MainActor
    func testReactsToSessionsUpdateEvent() {
        // (B4 FIX) RED stub — drive the bus directly and assert the binding updates.
        // Turns GREEN when Task 2 wires NotchEventBus.subscribe inside
        // SessionsSidebarView.onAppear AND adds publishForTesting on the bus.
        var sessions: [SessionStatusEntry] = []
        let binding = Binding(get: { sessions }, set: { sessions = $0 })
        let view = SessionsSidebarView(sessions: binding)
        // Force body materialization so onAppear-style subscriptions register.
        _ = view.body

        let payload = SessionsUpdatePayload(
            pids: [42],
            ts: 0,
            sessions: [.init(pid: 42, repo: "x", status: "working", conflict: nil)]
        )
        NotchEventBus.shared.publishForTesting(.sessionsUpdate(payload))

        // Allow the DispatchQueue.main.async dispatch inside the subscriber
        // to drain before asserting on the binding.
        let exp = expectation(description: "sessions binding updates")
        DispatchQueue.main.async {
            if !sessions.isEmpty { exp.fulfill() }
        }
        wait(for: [exp], timeout: 1.0)
        XCTAssertEqual(sessions.first?.pid, 42)
        XCTAssertEqual(sessions.first?.status, "working")
    }
}
