import SwiftUI

@main
struct JarvisTrayApp: App {
    @ObservedObject var manager = ServiceManager.shared
    @ObservedObject var notch = NotchProcessController.shared

    init() {
        manager.startPolling()
        // Launch the separate JarvisNotch process automatically. The user
        // can toggle it off from the menubar popover; it stays a child
        // process so a notch crash does NOT bring the menubar down.
        DispatchQueue.main.async {
            NotchProcessController.shared.startIfWanted()
        }
    }

    var body: some Scene {
        MenuBarExtra {
            JarvisPopoverView()
                .fixedSize(horizontal: false, vertical: true)
        } label: {
            Image(systemName: "server.rack")
        }
        .menuBarExtraStyle(.window)
        .windowResizability(.contentSize)
    }
}
