import Foundation
import CoreGraphics
import AppKit
import ScreenCaptureKit

/// On-device screen vision via the local Moondream Station daemon (port 2020).
///
/// This module is intentionally standalone: it has no SwiftUI / app state
/// dependency so the notch process (or any other host) can link it. The
/// daemon is supervised by launchd (`com.jarvis.moondream`); if it's down,
/// every call returns a structured error.
///
/// Latency on M2 Max 32GB with Moondream 2 (default model):
///   - first hit after a cold daemon: ~24s (weight load + warmup)
///   - steady-state caption ("short"): ~4s
///   - steady-state query/detect/point: ~3s
///
/// Permissions: capturing the active display requires the **Screen Recording**
/// entitlement on macOS. The host app must call
/// `CGRequestScreenCaptureAccess()` (System Settings → Privacy → Screen
/// Recording) on first run; this module surfaces the prompt for you when
/// `captureMainDisplay()` is called.
public enum ScreenVision {

    public struct Caption {
        public let text: String
        public let durationMs: Int
    }

    public struct Answer {
        public let text: String
        public let durationMs: Int
    }

    /// Normalized point — coords are 0…1 over the captured image bounds.
    /// Multiply by `imagePixelSize` to get screen pixels.
    public struct NormalizedPoint {
        public let x: Double
        public let y: Double
    }

    public enum VisionError: Error, CustomStringConvertible {
        case daemonUnreachable
        case screenCaptureDenied
        case captureFailed
        case encodingFailed
        case http(status: Int, body: String)
        case decodeFailed(String)
        case backend(String)

        public var description: String {
            switch self {
            case .daemonUnreachable:   return "Moondream daemon not reachable on :2020"
            case .screenCaptureDenied: return "Screen Recording permission denied — grant in System Settings"
            case .captureFailed:       return "CGDisplayCreateImage returned nil"
            case .encodingFailed:      return "Failed to encode CGImage as JPEG"
            case .http(let s, let b):  return "HTTP \(s): \(b.prefix(200))"
            case .decodeFailed(let m): return "JSON decode failed: \(m)"
            case .backend(let m):      return "Moondream backend error: \(m)"
            }
        }
    }

    // MARK: - Endpoint

    /// Override via env var VISION_LOCAL_URL if you ever move the daemon.
    private static var baseURL: URL {
        if let s = ProcessInfo.processInfo.environment["VISION_LOCAL_URL"],
           let u = URL(string: s) {
            return u
        }
        return URL(string: "http://127.0.0.1:2020")!
    }

    // MARK: - Health

    /// Cheap liveness probe. Use this before kicking off a long flow so
    /// you can fall back to a cloud VLM gracefully when the daemon is down.
    public static func isAvailable(timeout: TimeInterval = 1.5) async -> Bool {
        var req = URLRequest(url: baseURL.appendingPathComponent("health"))
        req.timeoutInterval = timeout
        do {
            let (_, response) = try await URLSession.shared.data(for: req)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    // MARK: - Capture

    /// Capture the current main display into a JPEG via ScreenCaptureKit.
    /// Triggers the Screen Recording permission prompt on first use.
    public static func captureMainDisplay(quality: CGFloat = 0.85) async throws -> Data {
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()
            if !CGPreflightScreenCaptureAccess() {
                throw VisionError.screenCaptureDenied
            }
        }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true
            )
        } catch {
            throw VisionError.screenCaptureDenied
        }
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
                ?? content.displays.first else {
            throw VisionError.captureFailed
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.width = display.width
        cfg.height = display.height
        cfg.showsCursor = false

        let cgImage: CGImage
        do {
            cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: cfg
            )
        } catch {
            throw VisionError.captureFailed
        }
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality]) else {
            throw VisionError.encodingFailed
        }
        return jpeg
    }

    // MARK: - Public ops

    /// One-line caption of the captured screen. ~4s steady-state.
    public static func captionScreen(length: String = "short") async throws -> Caption {
        let jpeg = try await captureMainDisplay()
        return try await captionData(jpeg, length: length)
    }

    /// VQA on the captured screen. Use for "what should I click?", "is X
    /// visible?", "describe the open app". ~3s steady-state.
    public static func queryScreen(_ question: String) async throws -> Answer {
        let jpeg = try await captureMainDisplay()
        return try await queryData(jpeg, question: question)
    }

    /// Locate a UI affordance — returns the first match. Multiply x,y by
    /// the screen size to get pixel coords for click_at_coords.
    public static func pointScreen(_ object: String) async throws -> NormalizedPoint? {
        let jpeg = try await captureMainDisplay()
        return try await pointData(jpeg, object: object)
    }

    // MARK: - Lower-level (any image bytes)

    public static func captionData(_ jpeg: Data, length: String = "short") async throws -> Caption {
        let body: [String: Any] = [
            "image_url": dataURL(jpeg),
            "length": length,
        ]
        let started = Date()
        let json = try await postJSON(path: "/v1/caption", body: body, timeout: 60)
        if let err = json["error"] as? String { throw VisionError.backend(err) }
        guard let text = json["caption"] as? String else {
            throw VisionError.decodeFailed("missing 'caption' field")
        }
        return Caption(text: text, durationMs: Int(Date().timeIntervalSince(started) * 1000))
    }

    public static func queryData(_ jpeg: Data, question: String) async throws -> Answer {
        let body: [String: Any] = [
            "image_url": dataURL(jpeg),
            "question": question,
        ]
        let started = Date()
        let json = try await postJSON(path: "/v1/query", body: body, timeout: 60)
        if let err = json["error"] as? String { throw VisionError.backend(err) }
        guard let text = json["answer"] as? String else {
            throw VisionError.decodeFailed("missing 'answer' field")
        }
        return Answer(text: text, durationMs: Int(Date().timeIntervalSince(started) * 1000))
    }

    public static func pointData(_ jpeg: Data, object: String) async throws -> NormalizedPoint? {
        let body: [String: Any] = [
            "image_url": dataURL(jpeg),
            "object": object,
        ]
        let json = try await postJSON(path: "/v1/point", body: body, timeout: 60)
        if let err = json["error"] as? String { throw VisionError.backend(err) }
        guard let arr = json["points"] as? [[String: Any]], let first = arr.first,
              let x = first["x"] as? Double, let y = first["y"] as? Double else {
            return nil
        }
        return NormalizedPoint(x: x, y: y)
    }

    // MARK: - Internals

    private static func dataURL(_ jpeg: Data) -> String {
        return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
    }

    private static func postJSON(path: String, body: [String: Any], timeout: TimeInterval) async throws -> [String: Any] {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw VisionError.daemonUnreachable
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw VisionError.http(status: status, body: body)
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else {
            throw VisionError.decodeFailed("not a JSON object")
        }
        return json
    }
}
