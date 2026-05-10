import XCTest
@testable import JarvisNotch

/// ORC-14 — verifies the JSON wire shape from the router (`sessions:update` +
/// `todos:update`) decodes into the typed `NotchEvent` union.
///
/// RED at Wave 0 (the new cases + payload structs do not exist yet).
/// GREEN after Task 2 lands `case sessionsUpdate` / `case todosUpdate` in
/// `NotchEvents.swift` and adds the matching `Codable` payload structs.
final class NotchEventDecoderTests: XCTestCase {
    func testDecodesSessionsUpdate() throws {
        let json = #"{"type":"sessions:update","data":{"pids":[1234,5678],"ts":1715000000,"sessions":[{"pid":1234,"repo":"jarvis","status":"awaiting_user_input","conflict":null}]}}"#
        let data = json.data(using: .utf8)!
        let event = try JSONDecoder().decode(NotchEvent.self, from: data)
        guard case .sessionsUpdate(let payload) = event else {
            return XCTFail("wrong case — expected .sessionsUpdate")
        }
        XCTAssertEqual(payload.pids, [1234, 5678])
        XCTAssertEqual(payload.sessions?.first?.status, "awaiting_user_input")
        XCTAssertEqual(payload.sessions?.first?.repo, "jarvis")
    }

    func testDecodesTodosUpdate() throws {
        let json = #"{"type":"todos:update","data":{"count":3,"ts":1715000000,"topThree":[{"id":"AAA-1","title":"Plan 02-01","pid":12345,"phase":"plan"}]}}"#
        let data = json.data(using: .utf8)!
        let event = try JSONDecoder().decode(NotchEvent.self, from: data)
        guard case .todosUpdate(let payload) = event else {
            return XCTFail("wrong case — expected .todosUpdate")
        }
        XCTAssertEqual(payload.count, 3)
        XCTAssertEqual(payload.topThree?.first?.title, "Plan 02-01")
        XCTAssertEqual(payload.topThree?.first?.pid, 12345)
    }

    func testUnknownEventTypeDoesNotCrash() throws {
        let json = #"{"type":"some:future:event","data":{}}"#
        let data = json.data(using: .utf8)!
        // Decoding may throw OR return a fallback — either is acceptable;
        // the only contract is that it does not crash the runtime.
        _ = try? JSONDecoder().decode(NotchEvent.self, from: data)
    }
}
