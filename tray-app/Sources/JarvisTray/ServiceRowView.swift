import SwiftUI

struct ServiceRowView: View {
    let service: ServiceInfo
    let status: ServiceStatus
    let isLoaded: Bool
    let onStart: () -> Void
    let onStop: () -> Void
    let onRestart: () -> Void
    
    @State private var isHoveringRestart = false
    @State private var isHoveringToggle = false
    
    var body: some View {
        HStack(spacing: 10) {
            // Status dot
            statusIndicator
                .frame(width: 8, height: 8)
            
            // Service icon
            Image(systemName: service.sfSymbol)
                .font(.system(size: 13))
                .foregroundColor(.secondary)
                .frame(width: 18)
            
            // Name
            Text(service.name)
                .font(.system(.body, design: .rounded))
                .fontWeight(.medium)
                .lineLimit(1)
            
            Spacer()
            
            // Port
            Text(":\(service.port)")
                .font(.system(.caption, design: .monospaced))
                .foregroundColor(.secondary)
            
            // Restart button — lights up green if auto-restart is active
            Button(action: onRestart) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(
                        isHoveringRestart ? .orange :
                        isLoaded ? .green : .secondary.opacity(0.3)
                    )
                    .shadow(color: isLoaded ? .green.opacity(0.5) : .clear, radius: 2)
            }
            .buttonStyle(.plain)
            .onHover { isHoveringRestart = $0 }
            .help(isLoaded ? "Auto-restart: ON — Click to restart" : "Click to restart")
            .disabled(status != .online)
            
            // Start/Stop toggle
            Button(action: status == .online ? onStop : onStart) {
                Image(systemName: status == .online ? "stop.circle" : "play.circle")
                    .font(.system(size: 14))
                    .foregroundColor(isHoveringToggle ? (status == .online ? .red : .green) : .secondary.opacity(0.5))
            }
            .buttonStyle(.plain)
            .onHover { isHoveringToggle = $0 }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
    
    @ViewBuilder
    private var statusIndicator: some View {
        switch status {
        case .online:
            Circle()
                .fill(.green)
                .shadow(color: .green.opacity(0.5), radius: 3)
        case .offline:
            Circle()
                .fill(.red)
                .shadow(color: .red.opacity(0.3), radius: 2)
        case .restarting:
            ProgressView()
                .scaleEffect(0.4)
                .frame(width: 8, height: 8)
        }
    }
}
