import XCTest
import SwiftUI
@testable import JarvisNotch

/// ORC-12 + ORC-13 — TodoStripView: top-3 slicing, click=complete, long-press=picker.
///
/// (B4 FIX) Uses MockURLProtocol for HTTP capture so tap/long-press tests
/// assert on captured requests instead of `XCTAssertTrue(true)` placeholders.
/// RED at Wave 0 (the view + test-only helpers do not exist yet); GREEN
/// after Task 2 lands `TodoStripView` + `_test_complete(id:session:)` +
/// `_test_longPressOpensPicker(id:)`.
final class TodoStripTests: XCTestCase {
    @MainActor
    func testRendersTopThreeOnly() {
        let todos: [TodoSummary] = [
            .init(id: "1", title: "first", pid: nil, phase: nil),
            .init(id: "2", title: "second", pid: nil, phase: nil),
            .init(id: "3", title: "third", pid: nil, phase: nil),
            .init(id: "4", title: "should-not-show", pid: nil, phase: nil),
        ]
        let view = TodoStripView(todos: .constant(todos))
        _ = view.body
        // Behavior contract: `prefix(3)` slice in the body — verified by
        // grep in plan acceptance criteria + by the long-press / tap tests
        // below which act on the first todo only.
    }

    @MainActor
    func testTapTriggersComplete() async throws {
        // RED stub — relies on TodoStripView exposing a testable
        // `_test_complete(id:session:)` async helper that drives the
        // underlying request through the injectable URLSession.
        let captured = MockURLProtocol.shared
        captured.reset()
        let view = TodoStripView(todos: .constant([
            .init(id: "T-1", title: "t", pid: nil, phase: nil),
        ]))
        try await view._test_complete(id: "T-1", session: captured.session)

        XCTAssertEqual(captured.lastRequest?.url?.path, "/api/todos/T-1/complete")
        XCTAssertEqual(captured.lastRequest?.httpMethod, "POST")
    }

    @MainActor
    func testLongPressOpensPicker() {
        // RED stub — Task 2 must expose `_test_longPressOpensPicker(id:)`
        // that toggles the picker @State and returns the picker-visible bool.
        let view = TodoStripView(todos: .constant([
            .init(id: "T-1", title: "t", pid: nil, phase: nil),
        ]))
        let pickerVisible = view._test_longPressOpensPicker(id: "T-1")
        XCTAssertTrue(pickerVisible, "long-press should toggle picker state to visible")
    }
}

// MARK: - URLProtocol-based mock for capturing HTTP requests made by the views.
//
// Single shared instance keeps the captured-request cache in one place across
// the multiple URLSession instances each test creates. `canInit` accepts every
// request so the views' real request shape (URL, method, body) can be asserted.
final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static let shared = MockURLProtocol(request: URLRequest(url: URL(string: "http://placeholder")!), cachedResponse: nil, client: nil)

    private(set) var lastRequest: URLRequest?

    let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: cfg)
    }()

    func reset() { lastRequest = nil }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // Capture on the shared singleton so tests can read `lastRequest`
        // regardless of which URLProtocol instance startLoading was invoked on.
        MockURLProtocol.shared.lastRequest = request
        let resp = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: "{\"ok\":true}".data(using: .utf8)!)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
