import SwiftUI
import AppKit
import AVFoundation
import Speech

/// Standalone notch process. Spawned by JarvisTray.app via launchctl or
/// direct `Process`, lives in `/Applications/JarvisNotch.app`. Keeps the
/// DynamicNotchKit + WKWebView + CGEventTap + mic capture OFF the
/// menubar process so a notch crash doesn't take the tray with it.
///
/// Communication with the rest of Jarvis happens exclusively through the
/// router (localhost:3340): prefs via `/api/notch/prefs`, voice uploads
/// via `/api/notch/voice`, SSE stream via `/api/notch/stream`. No XPC, no
/// shared memory — the router already is our IPC bus.
/// Minimal NSApplicationDelegate to pin the activation policy to
/// `.accessory` at startup. Without this, a SwiftUI App whose only Scene
/// is `Settings { EmptyView() }` starts in `.regular` and macOS never
/// orders the DynamicNotchKit panel front — the notch exists but is
/// invisible because the app is effectively "not on screen". LSUIElement
/// in Info.plist should do this too, but the SwiftUI scene lifecycle
/// overrides it, so we force it programmatically.
final class NotchAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // Trigger TCC prompts upfront so the first hover doesn't fail
        // silently. SFSpeechRecognizer + Microphone are needed for the
        // realtime Apple-on-device transcription that powers the live
        // bubble in compact mode. Doing this here (vs lazy on first
        // hover) gives the user a chance to grant before they actually
        // try to talk.
        SFSpeechRecognizer.requestAuthorization { status in
            NotchLogger.shared.log("info", "[perm] speech=\(status.rawValue)")
        }
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            NotchLogger.shared.log("info", "[perm] mic=\(granted)")
        }
    }
}

@main
struct JarvisNotchApp: App {
    @NSApplicationDelegateAdaptor(NotchAppDelegate.self) var delegate

    init() {
        // Defer the notch mount by one run-loop tick so NSScreen reports
        // the safe area insets correctly.
        DispatchQueue.main.async {
            NotchController.shared.mount()
        }
    }

    /// No UI scene — this process is headless except for the notch panel.
    /// `Settings` (empty) satisfies the App protocol's "at least one scene"
    /// requirement; a `MenuBarExtra` here would double-render the menubar
    /// owned by JarvisTray.
    var body: some Scene {
        Settings { EmptyView() }
    }
}
