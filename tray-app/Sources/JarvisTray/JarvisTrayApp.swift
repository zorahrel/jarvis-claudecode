import SwiftUI

@main
struct JarvisTrayApp: App {
    @ObservedObject var manager = ServiceManager.shared

    init() {
        manager.startPolling()
    }

    var body: some Scene {
        MenuBarExtra {
            JarvisPopoverView()
                .frame(width: 320, height: 420)
        } label: {
            Image(systemName: "server.rack")
        }
        .menuBarExtraStyle(.window)
    }
}
