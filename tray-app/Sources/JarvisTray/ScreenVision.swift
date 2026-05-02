import Foundation
import CoreGraphics
import AppKit
import ScreenCaptureKit

/// Screen vision via Moondream — cloud or local, picked at runtime.
///
/// Backend selection (transparent to callers):
///   - **Cloud** when `MOONDREAM_API_KEY` is set in the process env. Hits
///     `https://api.moondream.ai/v1` with `X-Moondream-Auth`. Server-side
///     Moondream 3, ~0.5–1.1s per call, ~$0.000068/image (Personal tier
///     includes ~70k images/mo). Best quality, sub-second, but the
///     screenshot leaves the device.
///   - **Local daemon** (default) at `http://127.0.0.1:2020`, served by
///     the `com.jarvis.moondream` launchd job (Moondream 2 on M2 Max).
///     Free, fully offline, slower (~3-4s/call). Override the URL with
///     `VISION_LOCAL_URL` if the daemon lives somewhere unusual.
///
/// This module is intentionally standalone — no SwiftUI / app state so
/// the notch process can link it directly.
///
/// Permissions: screen capture requires the **Screen Recording**
/// entitlement on macOS. The first call to `captureMainDisplay()`
/// surfaces the system prompt automatically.
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

    // MARK: - Endpoint selection

    public enum Backend { case cloud, local }

    /// `cloud` when `MOONDREAM_API_KEY` is set, `local` otherwise.
    public static var backend: Backend {
        return apiKey != nil ? .cloud : .local
    }

    private static var apiKey: String? {
        guard let k = ProcessInfo.processInfo.environment["MOONDREAM_API_KEY"], !k.isEmpty else {
            return nil
        }
        return k
    }

    private static var baseURL: URL {
        if backend == .cloud {
            return URL(string: "https://api.moondream.ai")!
        }
        if let s = ProcessInfo.processInfo.environment["VISION_LOCAL_URL"],
           let u = URL(string: s) {
            return u
        }
        return URL(string: "http://127.0.0.1:2020")!
    }

    // MARK: - Health

    /// Cheap liveness probe. For cloud we just confirm the key is set —
    /// no network call burned per check. For local we hit /health.
    public static func isAvailable(timeout: TimeInterval = 1.5) async -> Bool {
        if backend == .cloud { return apiKey != nil }
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
        if let key = apiKey { req.setValue(key, forHTTPHeaderField: "X-Moondream-Auth") }
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
