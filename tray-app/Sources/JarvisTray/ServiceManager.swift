import Foundation

struct ServiceInfo: Identifiable {
    let id: String
    let label: String
    let name: String
    let healthURL: String
    let port: Int
    let sfSymbol: String
    let plistContent: String

    init(label: String, name: String, healthURL: String, port: Int, sfSymbol: String, plistContent: String) {
        self.id = label
        self.label = label
        self.name = name
        self.healthURL = healthURL
        self.port = port
        self.sfSymbol = sfSymbol
        self.plistContent = plistContent
    }
}

enum ServiceStatus: Equatable {
    case online
    case offline
    case restarting
}

/// Response shape from GET /api/tray-services (served by the router).
private struct TrayServiceResponse: Decodable {
    let label: String
    let name: String
    let port: Int
    let healthURL: String
    let plistContent: String
}

@MainActor
class ServiceManager: ObservableObject {
    static let shared = ServiceManager()

    @Published var services: [ServiceInfo] = []
    @Published var serviceStatuses: [String: ServiceStatus] = [:]
    @Published var serviceLoaded: [String: Bool] = [:]
    @Published var routerStats: RouterStats?

    private var healthTimer: Timer?
    private var syncTimer: Timer?
    private let home = FileManager.default.homeDirectoryForCurrentUser.path

    struct RouterStats {
        var messagesToday: Int = 0
        var activeProcesses: Int = 0
        var uptime: String = "N/A"
    }

    var allUp: Bool {
        services.allSatisfy { serviceStatuses[$0.label] == .online }
    }

    var downCount: Int {
        services.filter { serviceStatuses[$0.label] != .online }.count
    }

    init() {
        // Start with a local fallback containing only the Router so the tray can
        // bring the router up even when it's offline. Extra services arrive via
        // /api/tray-services on the first successful sync.
        services = [fallbackRouter()]
    }

    // MARK: - Local fallback (router bootstrap)

    private func fallbackRouter() -> ServiceInfo {
        let h = home
        let routerDir = "\(h)/.claude/jarvis/router"
        let logDir = "\(h)/.claude/jarvis/logs"
        let nodePath = "\(h)/.nvm/versions/node/v25.5.0/bin/node"
        let tsxPath = "\(h)/.nvm/versions/node/v25.5.0/bin/tsx"
        let envPath = "\(h)/.nvm/versions/node/v25.5.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>com.jarvis.router</string>
            <key>ProgramArguments</key>
            <array>
                <string>\(nodePath)</string>
                <string>\(tsxPath)</string>
                <string>src/index.ts</string>
            </array>
            <key>WorkingDirectory</key>
            <string>\(routerDir)</string>
            <key>RunAtLoad</key>
            <true/>
            <key>KeepAlive</key>
            <true/>
            <key>StandardOutPath</key>
            <string>\(logDir)/router.log</string>
            <key>StandardErrorPath</key>
            <string>\(logDir)/router-error.log</string>
            <key>EnvironmentVariables</key>
            <dict>
                <key>PATH</key>
                <string>\(envPath)</string>
                <key>HOME</key>
                <string>\(h)</string>
            </dict>
        </dict>
        </plist>
        """
        return ServiceInfo(
            label: "com.jarvis.router", name: "Router",
            healthURL: "http://localhost:3340/api/stats", port: 3340,
            sfSymbol: "network", plistContent: plist
        )
    }

    // MARK: - Polling

    func startPolling() {
        syncServices()
        checkAll()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkAll() }
        }
        // Re-fetch services from the router every 30s so new entries in config.yaml
        // show up without restarting the tray.
        syncTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.syncServices() }
        }
    }

    func stopPolling() {
        healthTimer?.invalidate()
        syncTimer?.invalidate()
    }

    /// Fetch the service list from the router. If the router is unreachable, keep
    /// the current list (or fallback) so the user can still start the router.
    private func syncServices() {
        guard let url = URL(string: "http://localhost:3340/api/tray-services") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] data, _, error in
            guard let data = data, error == nil,
                  let decoded = try? JSONDecoder().decode([TrayServiceResponse].self, from: data) else {
                return
            }
            Task { @MainActor in
                guard let self = self else { return }
                let fresh = decoded.map { dto -> ServiceInfo in
                    ServiceInfo(
                        label: dto.label, name: dto.name,
                        healthURL: dto.healthURL, port: dto.port,
                        sfSymbol: self.symbolFor(name: dto.name),
                        plistContent: dto.plistContent
                    )
                }
                if !fresh.isEmpty {
                    self.services = fresh
                }
            }
        }.resume()
    }

    private func symbolFor(name: String) -> String {
        switch name {
        case "Router": return "network"
        case "ChromaDB": return "internaldrive"
        case "Mem0": return "brain"
        default: return "server.rack"
        }
    }

    private func checkAll() {
        for svc in services { checkHealth(svc) }
        fetchRouterStats()
        updateLoadedStatus()
    }

    // MARK: - Health

    /// URLSession that trusts self-signed certs (for services exposed over HTTPS)
    private static let insecureSession: URLSession = {
        let delegate = InsecureDelegate()
        return URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
    }()

    private func checkHealth(_ svc: ServiceInfo) {
        guard let url = URL(string: svc.healthURL) else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        let session = svc.healthURL.hasPrefix("https") ? ServiceManager.insecureSession : URLSession.shared
        session.dataTask(with: req) { [weak self] _, response, error in
            let ok = error == nil && ((response as? HTTPURLResponse).map { 200...499 ~= $0.statusCode } ?? false)
            Task { @MainActor in
                let current = self?.serviceStatuses[svc.label]
                if current == .restarting && ok {
                    self?.serviceStatuses[svc.label] = .online
                } else if current != .restarting {
                    self?.serviceStatuses[svc.label] = ok ? .online : .offline
                }
            }
        }.resume()
    }

    private func fetchRouterStats() {
        guard let url = URL(string: "http://localhost:3340/api/stats") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] data, _, error in
            guard let data = data, error == nil,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            Task { @MainActor in
                var stats = RouterStats()
                stats.messagesToday = json["messagesToday"] as? Int ?? json["messages_today"] as? Int ?? 0
                stats.activeProcesses = json["activeProcesses"] as? Int ?? json["active_processes"] as? Int ?? 0
                stats.uptime = json["uptime"] as? String ?? "N/A"
                self?.routerStats = stats
            }
        }.resume()
    }

    // MARK: - Plist management

    func installPlistIfNeeded(_ svc: ServiceInfo) {
        let path = "\(home)/Library/LaunchAgents/\(svc.label).plist"
        if !FileManager.default.fileExists(atPath: path) {
            try? svc.plistContent.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }

    func installAllPlists() {
        for svc in services { installPlistIfNeeded(svc) }
    }

    func startService(_ svc: ServiceInfo) {
        installPlistIfNeeded(svc)
        let path = "\(home)/Library/LaunchAgents/\(svc.label).plist"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.shell("launchctl load -w \(path)")
        }
    }

    func stopService(_ svc: ServiceInfo) {
        let path = "\(home)/Library/LaunchAgents/\(svc.label).plist"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.shell("launchctl unload \(path)")
        }
    }

    func restartService(_ svc: ServiceInfo) {
        if serviceStatuses[svc.label] == .restarting { return }
        serviceStatuses[svc.label] = .restarting
        let path = "\(home)/Library/LaunchAgents/\(svc.label).plist"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            // Check if KeepAlive is enabled
            let plistCheck = self.shell("plutil -p '\(path)' 2>/dev/null | grep KeepAlive")
            let hasKeepAlive = plistCheck.contains("true")

            if hasKeepAlive {
                // KeepAlive=true: kill the launchd-tracked PID, launchd auto-respawns.
                let pidOutput = self.shell("launchctl list \(svc.label) 2>/dev/null | grep PID | awk '{print $NF}' | tr -d ';'")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let pid = Int(pidOutput), pid > 0 {
                    self.shell("kill -9 \(pid) 2>/dev/null")
                }
            } else {
                // No KeepAlive: manual unload + kill + load
                let pidOutput = self.shell("launchctl list \(svc.label) 2>/dev/null | grep PID | awk '{print $NF}' | tr -d ';'")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                self.shell("launchctl unload \(path) 2>/dev/null")
                if let pid = Int(pidOutput), pid > 0 {
                    self.shell("kill -9 \(pid) 2>/dev/null")
                }
                Thread.sleep(forTimeInterval: 1.0)
                self.shell("launchctl load -w \(path)")
            }
        }
    }

    func startAll() { for svc in services { startService(svc) } }
    func stopAll() { for svc in services { stopService(svc) } }

    /// Returns true if the service has KeepAlive=true AND is loaded in launchd
    func isServiceLoaded(_ label: String) -> Bool {
        return serviceLoaded[label] ?? false
    }

    private func updateLoadedStatus() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            let currentServices = DispatchQueue.main.sync { self.services }
            for svc in currentServices {
                let listOutput = self.shell("launchctl list 2>/dev/null | grep \(svc.label)")
                let isLaunchdLoaded = !listOutput.isEmpty

                let plistPath = "\(self.home)/Library/LaunchAgents/\(svc.label).plist"
                let plistOutput = self.shell("plutil -p '\(plistPath)' 2>/dev/null | grep KeepAlive")
                let hasKeepAlive = plistOutput.contains("true")

                let autoRestart = isLaunchdLoaded && hasKeepAlive

                DispatchQueue.main.async {
                    self.serviceLoaded[svc.label] = autoRestart
                }
            }
        }
    }

    // MARK: - Launch at Login

    var launchAtLogin: Bool {
        let path = "\(home)/Library/LaunchAgents/com.jarvis.tray.plist"
        return FileManager.default.fileExists(atPath: path)
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        let path = "\(home)/Library/LaunchAgents/com.jarvis.tray.plist"
        if enabled {
            let binary = "\(home)/bin/jarvis-tray"
            let plist = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
                <key>Label</key>
                <string>com.jarvis.tray</string>
                <key>ProgramArguments</key>
                <array>
                    <string>\(binary)</string>
                </array>
                <key>RunAtLoad</key>
                <true/>
                <key>KeepAlive</key>
                <false/>
            </dict>
            </plist>
            """
            try? plist.write(toFile: path, atomically: true, encoding: .utf8)
            shell("launchctl load -w \(path)")
        } else {
            shell("launchctl unload \(path)")
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    @discardableResult
    func shell(_ command: String) -> String {
        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-c", command]
        task.standardOutput = pipe
        task.standardError = pipe
        try? task.run()
        task.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
}

/// URLSession delegate that accepts self-signed certificates
class InsecureDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}
