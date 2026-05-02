import SwiftUI

struct JarvisPopoverView: View {
    @ObservedObject var manager = ServiceManager.shared
    @ObservedObject var notch = NotchProcessController.shared

    var body: some View {
        VStack(spacing: 0) {
            // Header
            headerSection

            Divider().padding(.horizontal, 12)

            // Services
            servicesSection

            Divider().padding(.horizontal, 12)

            // Notch toggle — the notch lives in a separate process
            // (JarvisNotch.app). Turning this off SIGTERMs it; turning it
            // on respawns. Crash recovery is automatic via
            // NotchProcessController's 2 s poll loop.
            notchSection

            Divider().padding(.horizontal, 12)

            // Stats
            if let stats = manager.routerStats {
                statsSection(stats)
                Divider().padding(.horizontal, 12)
            }

            // Actions
            actionsSection

            Divider().padding(.horizontal, 12)

            // Footer
            footerSection
        }
        .frame(width: 320)
        .background(.ultraThinMaterial)
    }

    private var notchSection: some View {
        HStack(spacing: 10) {
            Image(systemName: notch.isRunning ? "rectangle.dashed.fill" : "rectangle.dashed")
                .foregroundColor(notch.isRunning ? .accentColor : .secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text("Notch")
                    .font(.system(.body, design: .default))
                Text(notch.isRunning ? "in esecuzione" : (notch.wanted ? "in avvio…" : "spento"))
                    .font(.system(.caption))
                    .foregroundColor(.secondary)
            }
            Spacer()
            Toggle("", isOn: Binding(
                get: { notch.wanted },
                set: { $0 ? notch.start() : notch.stop() }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
    
    // MARK: - Header
    
    private var headerSection: some View {
        HStack {
            Image(systemName: "server.rack")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.accentColor)
            Text("JARVIS")
                .font(.system(.headline, design: .rounded))
                .fontWeight(.bold)
            Spacer()
            Text("v1.0")
                .font(.system(.caption, design: .monospaced))
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
    
    // MARK: - Services
    
    private var servicesSection: some View {
        VStack(spacing: 0) {
            ForEach(manager.services) { svc in
                ServiceRowView(
                    service: svc,
                    status: manager.serviceStatuses[svc.label] ?? .offline,
                    isLoaded: manager.isServiceLoaded(svc.label),
                    onStart: { manager.startService(svc) },
                    onStop: { manager.stopService(svc) },
                    onRestart: { manager.restartService(svc) }
                )
            }
        }
        .padding(.vertical, 4)
    }
    
    // MARK: - Stats
    
    private func statsSection(_ stats: ServiceManager.RouterStats) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "chart.bar")
                .font(.system(size: 10))
                .foregroundColor(.secondary)
            Text("\(stats.messagesToday) msgs")
            Text("•").foregroundColor(.secondary)
            Text("\(stats.activeProcesses) procs")
            Text("•").foregroundColor(.secondary)
            Text(stats.uptime)
        }
        .font(.system(.caption, design: .monospaced))
        .foregroundColor(.secondary)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
    
    // MARK: - Actions
    
    private var actionsSection: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                ActionButton(title: "Start All", icon: "play.fill", color: .green) {
                    manager.startAll()
                }
                ActionButton(title: "Stop All", icon: "stop.fill", color: .red) {
                    manager.stopAll()
                }
            }
            
            ActionButton(title: "Dashboard", icon: "chart.bar.doc.horizontal", color: .accentColor) {
                NSWorkspace.shared.open(URL(string: "http://localhost:3340")!)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
    
    // MARK: - Footer
    
    private var footerSection: some View {
        HStack {
            Toggle(isOn: Binding(
                get: { manager.launchAtLogin },
                set: { manager.setLaunchAtLogin($0) }
            )) {
                Text("Launch at Login")
                    .font(.system(.caption))
            }
            .toggleStyle(.checkbox)
            
            Spacer()
            
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
            .buttonStyle(.plain)
            .font(.system(.caption))
            .foregroundColor(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

// MARK: - Action Button

struct ActionButton: View {
    let title: String
    let icon: String
    let color: Color
    let action: () -> Void
    
    @State private var isHovering = false
    
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                Text(title)
                    .font(.system(.caption, design: .rounded))
                    .fontWeight(.medium)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isHovering ? color.opacity(0.15) : Color.secondary.opacity(0.08))
            )
            .foregroundColor(isHovering ? color : .primary)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
    }
}
