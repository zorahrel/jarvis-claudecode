// swift-tools-version: 5.9
import PackageDescription

// JarvisTray-only package.
//
// The notch process (JarvisNotch.app) is built from a SEPARATE repo:
//   https://github.com/zorahrel/agent-notch   →   ~/agent-notch
//
// The tray supervises /Applications/JarvisNotch.app via NotchProcessController,
// but neither imports nor builds it here. To rebuild and reinstall the notch
// from the agent-notch repo, run `./redeploy-notch.sh` (dev) or
// `./make-app.sh --install` (full install).
let package = Package(
    name: "JarvisTray",
    platforms: [.macOS(.v14)],
    targets: [
        // Menubar app — always on, no heavy native dependencies. Spawns and
        // supervises /Applications/JarvisNotch.app when the user toggles it
        // from the popover.
        .executableTarget(
            name: "JarvisTray",
            dependencies: []
        ),
    ]
)
