// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Jarvis",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/MrKai77/DynamicNotchKit", from: "1.1.0"),
    ],
    targets: [
        // Menubar app — always on, no heavy native dependencies. Spawns and
        // supervises JarvisNotch when the user toggles it from the popover.
        .executableTarget(
            name: "JarvisTray",
            dependencies: []
        ),
        // Notch app — isolated process so a crash here doesn't kill the
        // menubar. Owns DynamicNotchKit, the WKWebView, the CGEventTap and
        // the mic capture pipeline. Talks to the router over HTTP for
        // everything stateful.
        .executableTarget(
            name: "JarvisNotch",
            dependencies: [
                .product(name: "DynamicNotchKit", package: "DynamicNotchKit"),
            ],
            resources: [
                .copy("Orb"),
            ]
        ),
        // XCTest target for JarvisNotch — Phase 2 Plan 02-03.
        // Covers ORC-11..14: SessionsSidebarView, TodoStripView, NotchEvent
        // decoder for sessions:update + todos:update, and reconnect-state
        // preservation in NotchEventBus.
        .testTarget(
            name: "JarvisNotchTests",
            dependencies: ["JarvisNotch"],
            path: "Tests/JarvisNotchTests"
        ),
    ]
)
