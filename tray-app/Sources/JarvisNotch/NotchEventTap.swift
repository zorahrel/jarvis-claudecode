import Cocoa
import ApplicationServices

// MARK: - CGEvent tap (physical notch cutout → expand)

/// Low-level event tap that receives every left-mouse-down on the system,
/// including clicks in the MacBook notch cutout area — where no NSPanel
/// ever gets mouseDown because macOS treats those pixels as a hardware
/// dead zone. Requires Accessibility permission (prompted on first launch).
///
/// CG coordinates: origin is TOP-LEFT, Y grows DOWN. That's opposite of
/// NSEvent.mouseLocation, so we check `y <= NotchTuning.compactZoneMaxY`.
@MainActor
final class NotchEventTap {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    /// Called for EVERY left-mouse-down observed by the tap. The boolean
    /// argument tells the controller whether the click landed inside the
    /// notch hit zone, so it can decide to expand / collapse accordingly.
    private let onNotchClick: (Bool) -> Void
    init(onNotchClick: @escaping (Bool) -> Void) {
        self.onNotchClick = onNotchClick
        install()
    }

    deinit {
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source = source {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
        }
    }

    private func install() {
        // Listen for mouseDown PLUS the two "tap got disabled" meta-events —
        // macOS throws those when the tap callback takes too long (timeout)
        // or when the user triggers something that forces a reset. We MUST
        // re-enable in that case, otherwise the tap goes silent forever.
        // Only listen for clicks here — mouseMoved is handled by
        // NSEvent.addGlobalMonitorForEvents in the controller. Piping the
        // mouseMoved firehose through a CGEvent tap starves the main actor
        // and causes macOS to disable the tap with tapDisabledByTimeout on
        // every click. Keeping the tap click-only eliminates that churn.
        let mask: CGEventMask =
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.tapDisabledByTimeout.rawValue) |
            (1 << CGEventType.tapDisabledByUserInput.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            guard let userInfo else { return Unmanaged.passUnretained(event) }
            let me = Unmanaged<NotchEventTap>.fromOpaque(userInfo).takeUnretainedValue()

            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                Task { @MainActor in
                    NotchLogger.shared.log("warn", "[tap] disabled (\(type.rawValue)) — re-enabling")
                    if let tap = me.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                }
                return Unmanaged.passUnretained(event)
            }

            if type == .leftMouseDown {
                let loc = event.location
                Task { @MainActor in
                    let notchScreen = NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main
                    guard let screen = notchScreen else { return }
                    let midX = screen.frame.midX
                    let nearTop = loc.y <= NotchTuning.compactZoneMaxY
                    let nearCenter = abs(loc.x - midX) <= NotchTuning.compactZoneHalfWidth
                    NotchLogger.shared.log("info",
                        "[tap] click cg=(\(Int(loc.x)),\(Int(loc.y))) inside=\(nearTop && nearCenter)")
                    me.onNotchClick(nearTop && nearCenter)
                }
            }
            return Unmanaged.passUnretained(event)
        }

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            NotchLogger.shared.log("warn", "[tap] CGEvent.tapCreate returned nil — Accessibility permission needed")
            requestAccessibilityPermission()
            return
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        NotchLogger.shared.log("info", "[tap] CGEvent tap installed")
    }

    private func requestAccessibilityPermission() {
        // Present the system Accessibility prompt so the user can grant
        // us permission without digging into System Settings manually.
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as NSString
        let options: NSDictionary = [key: true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
    }
}
