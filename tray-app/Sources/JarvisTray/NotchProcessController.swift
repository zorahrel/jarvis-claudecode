import Foundation
import SwiftUI
import AppKit

/// Supervises the separate `JarvisNotch.app` process so a notch crash
/// doesn't bring the menubar down. Exposes `wanted` (user intent,
/// persisted to UserDefaults) and `isRunning` (live pgrep poll) so the
/// popover can render a simple on/off toggle.
///
/// Lookup order for the helper binary:
///   1. `/Applications/JarvisNotch.app` — installed copy (normal case)
///   2. `$SRCROOT/.build/debug/JarvisNotch` — dev build without packaging
/// If neither is found the toggle stays off and logs a warning.
@MainActor
final class NotchProcessController: ObservableObject {
    static let shared = NotchProcessController()

    /// User intent — persisted. `true` means "spawn on launch and respawn
    /// if it crashes"; `false` means "leave it off even if installed".
    @Published var wanted: Bool {
        didSet { UserDefaults.standard.set(wanted, forKey: "jarvis.notch.wanted") }
    }
    @Published private(set) var isRunning: Bool = false

    private var monitor: Timer?
    private let processName = "JarvisNotch"

    private init() {
        self.wanted = UserDefaults.standard.object(forKey: "jarvis.notch.wanted") as? Bool ?? true
        self.isRunning = pidOfHelper() != nil
        // Every 2 s: refresh live state, and if `wanted == true` but the
        // helper is not running, respawn it (crash-recovery).
        self.monitor = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func startIfWanted() {
        if wanted && !isRunning { spawn() }
    }

    func start() {
        wanted = true
        if !isRunning { spawn() }
    }

    func stop() {
        wanted = false
        killHelper()
    }

    func toggle() { wanted ? stop() : start() }

    // MARK: - Internals

    private func tick() {
        let pid = pidOfHelper()
        let running = (pid != nil)
        if running != isRunning { isRunning = running }
        if wanted && !running { spawn() }
    }

    private func spawn() {
        guard let url = helperAppURL() else {
            NSLog("[NotchProcessController] JarvisNotch binary not found; install the app or run make-app.sh")
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        config.addsToRecentItems = false
        config.hides = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { [weak self] _, error in
            if let error { NSLog("[NotchProcessController] launch failed: %@", error.localizedDescription) }
            Task { @MainActor in self?.isRunning = self?.pidOfHelper() != nil }
        }
    }

    private func killHelper() {
        guard let pid = pidOfHelper() else { return }
        kill(pid, SIGTERM)
        // Give it a beat to shut down, then hard-kill if it hung.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            if let p = self?.pidOfHelper() { kill(p, SIGKILL) }
            Task { @MainActor in self?.isRunning = self?.pidOfHelper() != nil }
        }
    }

    /// Prefer the installed `.app` bundle; fall back to the dev build in
    /// `.build/debug/` so developers without a real install still get a
    /// working toggle. We don't ship the raw executable in production.
    private func helperAppURL() -> URL? {
        let installed = URL(fileURLWithPath: "/Applications/JarvisNotch.app")
        if FileManager.default.fileExists(atPath: installed.path) { return installed }
        // Dev fallback: walk up from the executable to find the swift build.
        let here = Bundle.main.bundleURL.deletingLastPathComponent()
        let candidates = [
            here.appendingPathComponent(".build/debug/JarvisNotch"),
            here.deletingLastPathComponent().appendingPathComponent(".build/debug/JarvisNotch"),
        ]
        for c in candidates where FileManager.default.fileExists(atPath: c.path) { return c }
        return nil
    }

    private func pidOfHelper() -> pid_t? {
        let task = Process()
        task.launchPath = "/usr/bin/pgrep"
        task.arguments = ["-x", processName]
        let out = Pipe()
        task.standardOutput = out
        task.standardError = Pipe()
        do { try task.run() } catch { return nil }
        task.waitUntilExit()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let str = String(data: data, encoding: .utf8) ?? ""
        // pgrep returns all matching PIDs one per line; first is fine.
        guard let line = str.split(separator: "\n").first,
              let pid = pid_t(line.trimmingCharacters(in: .whitespaces))
        else { return nil }
        return pid
    }
}
