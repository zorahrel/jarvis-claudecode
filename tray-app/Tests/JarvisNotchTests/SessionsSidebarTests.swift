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
    override func setUp() {
        super.setUp()
        // Avoid order-dependent bleed-through from the reconnect test which
        // seeds pid=[1,2] into the cache; we want a pristine bus.
        NotchEventBus.shared.resetForTesting()
    }

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
        // (B4 FIX) Drive the bus directly and assert the view's subscription
        // updates the externally-owned sessions array. SwiftUI does not run
        // `.onAppear` for views materialized only in unit tests, so the view
        // exposes a `_test_installSubscription(setSessions:)` helper that
        // registers exactly the closure `.onAppear` registers in production.
        // Reference the view type so the test still compiles against the
        // production view contract.
        _ = SessionsSidebarView(sessions: .constant([]))

        // Box the captured sessions in a class so the closure can mutate
        // it without bumping into Swift's Sendable rules around inout
        // captures inside @escaping closures.
        final class Box: @unchecked Sendable { var value: [SessionStatusEntry] = [] }
        let box = Box()

        let unsubscribe = SessionsSidebarView._test_installSubscription { sess in
            box.value = sess
        }
        defer { unsubscribe() }

        let payload = SessionsUpdatePayload(
            pids: [42],
            ts: 0,
            sessions: [.init(pid: 42, repo: "x", status: "working", conflict: nil)]
        )
        NotchEventBus.shared.publishForTesting(.sessionsUpdate(payload))

        // Drain the DispatchQueue.main.async hop the subscription performs.
        let exp = expectation(description: "sessions binding updates")
        DispatchQueue.main.async {
            DispatchQueue.main.async {
                exp.fulfill()
            }
        }
        wait(for: [exp], timeout: 1.0)

        XCTAssertEqual(box.value.first?.pid, 42)
        XCTAssertEqual(box.value.first?.status, "working")
    }
}
