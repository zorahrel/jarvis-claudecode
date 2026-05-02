import SwiftUI
import AppKit
import WebKit

// MARK: - MessagePeekView (NSView)

/// Compact-mode peek that reads as a downward extension of the system
/// notch. Drawn with a `NotchShape` silhouette (concave top corners that
/// curl into the notch curve, rounded bottom corners) and animated in
/// with a spring on transform.scale.y anchored at the top edge — same
/// pattern boring.notch / DynamicNotchKit use for their open animation.
final class MessagePeekView: NSView {
    private let label: NSTextField
    private let shape = CAShapeLayer()

    private var role: NotchController.PeekRole = .assistant

    /// Notch silhouette geometry. `topR` = small concave radius that
    /// matches the system notch's bottom-left/right curvature. `bottomR`
    /// = larger convex radius for a rounded pill bottom.
    private let topR: CGFloat = 8
    private let bottomR: CGFloat = 14

    override init(frame: NSRect) {
        let lbl = NSTextField(wrappingLabelWithString: "")
        lbl.font = .systemFont(ofSize: 12.5, weight: .regular)
        // No line cap — the peek panel grows vertically (extending the
        // black notch silhouette downward) so every message is fully
        // visible. Hard cap on the panel side via `preferredHeight`.
        lbl.maximumNumberOfLines = 0
        lbl.lineBreakMode = .byWordWrapping
        lbl.cell?.truncatesLastVisibleLine = false
        lbl.alignment = .center
        lbl.drawsBackground = false
        lbl.isBezeled = false
        lbl.isEditable = false
        lbl.isSelectable = false
        self.label = lbl

        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.masksToBounds = false
        // anchor=(0.5, 1) → the layer's y-scale grows DOWNWARD from the
        // top, so the panel "drops" out of the notch instead of inflating
        // from the centre.
        layer?.anchorPoint = CGPoint(x: 0.5, y: 1)

        shape.fillColor = NSColor(red: 0.03, green: 0.03, blue: 0.04, alpha: 0.96).cgColor
        layer?.addSublayer(shape)
        addSubview(lbl)
        applyRoleStyling()
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        // anchorPoint=(0.5,1) repositions the layer; counter-set position
        // so the visual rect still matches the panel bounds.
        layer?.frame = bounds
        layer?.position = CGPoint(x: bounds.midX, y: bounds.maxY)
        shape.frame = bounds
        shape.path = Self.notchExtensionPath(in: bounds, topR: topR, bottomR: bottomR)

        let inner: CGFloat = 18
        let textHeight = label.sizeThatFits(
            NSSize(width: bounds.width - inner * 2, height: .greatestFiniteMagnitude)
        ).height
        label.frame = NSRect(
            x: inner,
            y: (bounds.height - textHeight) / 2 - 1,
            width: bounds.width - inner * 2,
            height: textHeight
        )
        label.preferredMaxLayoutWidth = label.frame.width
    }

    func set(role: NotchController.PeekRole, text: String) {
        self.role = role
        label.stringValue = text
        applyRoleStyling()
        needsLayout = true
        layout()
    }

    func preferredHeight(forWidth width: CGFloat) -> CGFloat {
        let inner: CGFloat = 18
        let textWidth = width - inner * 2
        label.preferredMaxLayoutWidth = textWidth
        let h = label.sizeThatFits(NSSize(width: textWidth, height: .greatestFiniteMagnitude)).height
        // Min height matches the notch cutout so even a 1-line message
        // reads as a sibling of the system notch, not a thin sliver.
        // Max height ≈ 8 lines of body copy: keeps long replies / voice
        // transcripts fully visible (extending the notch downward in
        // black) without ever painting over half the screen.
        let raw = ceil(h) + 22
        return min(max(40, raw), 220)
    }

    /// Spring-down: layer starts squashed against the top edge (sy≈0.001)
    /// and springs to full height. Mirrors boring.notch's open spring
    /// (`response: 0.42, damping: 0.8`).
    func animateIn() {
        guard let l = layer else { return }
        let spring = CASpringAnimation(keyPath: "transform.scale.y")
        spring.fromValue = 0.001
        spring.toValue = 1.0
        spring.damping = 14
        spring.stiffness = 220
        spring.mass = 1
        spring.initialVelocity = 8
        spring.duration = spring.settlingDuration
        l.add(spring, forKey: "peek-in")
        l.transform = CATransform3DIdentity
    }

    func animateOut(completion: @escaping () -> Void) {
        guard let l = layer else { completion(); return }
        CATransaction.begin()
        CATransaction.setCompletionBlock(completion)
        let anim = CABasicAnimation(keyPath: "transform.scale.y")
        anim.fromValue = (l.presentation()?.value(forKeyPath: "transform.scale.y") as? CGFloat) ?? 1.0
        anim.toValue = 0.001
        anim.duration = 0.18
        anim.timingFunction = CAMediaTimingFunction(name: .easeIn)
        l.add(anim, forKey: "peek-out")
        l.transform = CATransform3DMakeScale(1, 0.001, 1)
        CATransaction.commit()
    }

    private func applyRoleStyling() {
        switch role {
        case .user:
            label.textColor = NSColor(red: 1.00, green: 0.78, blue: 0.40, alpha: 1)
        case .assistant:
            label.textColor = NSColor(white: 0.96, alpha: 1)
        }
    }

    /// NotchShape adapted from boring.notch (MIT) for AppKit's Y-up coords.
    /// Top corners (`topR`) curve INWARD to mate with the system notch's
    /// bottom curve; bottom corners (`bottomR`) round OUTWARD.
    static func notchExtensionPath(in rect: CGRect, topR: CGFloat, bottomR: CGFloat) -> CGPath {
        let path = CGMutablePath()
        let minX = rect.minX, maxX = rect.maxX
        let minY = rect.minY, maxY = rect.maxY
        path.move(to: CGPoint(x: minX, y: maxY))
        path.addQuadCurve(
            to: CGPoint(x: minX + topR, y: maxY - topR),
            control: CGPoint(x: minX + topR, y: maxY)
        )
        path.addLine(to: CGPoint(x: minX + topR, y: minY + bottomR))
        path.addQuadCurve(
            to: CGPoint(x: minX + topR + bottomR, y: minY),
            control: CGPoint(x: minX + topR, y: minY)
        )
        path.addLine(to: CGPoint(x: maxX - topR - bottomR, y: minY))
        path.addQuadCurve(
            to: CGPoint(x: maxX - topR, y: minY + bottomR),
            control: CGPoint(x: maxX - topR, y: minY)
        )
        path.addLine(to: CGPoint(x: maxX - topR, y: maxY - topR))
        path.addQuadCurve(
            to: CGPoint(x: maxX, y: maxY),
            control: CGPoint(x: maxX - topR, y: maxY)
        )
        path.closeSubpath()
        return path
    }
}

// MARK: - NotchAuraView (NSView)

/// Voice-mode aura around the system notch cutout. Visible whenever
/// there's something cancellable (recording or agent active) — gives
/// the user a "Jarvis is listening / thinking" cue even when the notch
/// is collapsed and the orb glow alone is too subtle.
@MainActor
final class NotchAuraView: NSView {
    private let halo = CAShapeLayer()
    var notchHeight: CGFloat = 38 { didSet { needsLayout = true } }
    private var isActive: Bool = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.masksToBounds = false

        // Halo: a stroked NotchShape with a large soft shadow that bleeds
        // OUT around the cutout silhouette. The stroke itself is mostly
        // transparent — the visual is dominated by the layer shadow.
        halo.fillColor = NSColor.clear.cgColor
        halo.strokeColor = NSColor(red: 1.00, green: 0.74, blue: 0.32, alpha: 0.85).cgColor
        halo.lineWidth = 1.5
        halo.shadowColor = NSColor(red: 1.00, green: 0.74, blue: 0.32, alpha: 1).cgColor
        halo.shadowOpacity = 0.85
        halo.shadowRadius = 18
        halo.shadowOffset = .zero
        layer?.addSublayer(halo)
        layer?.opacity = 0
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        // The notch cutout sits at the TOP of our panel, centred.
        // We draw a NotchShape silhouette for the cutout (~200×notchH)
        // and let the shadow bleed out into the surrounding area.
        let notchW: CGFloat = 200
        let notchRect = CGRect(
            x: bounds.midX - notchW / 2,
            y: bounds.maxY - notchHeight,
            width: notchW,
            height: notchHeight
        )
        halo.path = MessagePeekView.notchExtensionPath(in: notchRect, topR: 8, bottomR: 12)
        halo.frame = bounds
    }

    func setActive(_ active: Bool) {
        guard active != isActive else { return }
        isActive = active
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.fromValue = layer?.opacity
        anim.toValue = active ? 1 : 0
        anim.duration = 0.28
        layer?.add(anim, forKey: "active")
        layer?.opacity = active ? 1 : 0
        if active { startBreathing() } else { halo.removeAnimation(forKey: "breath") }
    }

    private func startBreathing() {
        if halo.animation(forKey: "breath") != nil { return }
        let b = CABasicAnimation(keyPath: "shadowRadius")
        b.fromValue = 14
        b.toValue = 22
        b.duration = 1.4
        b.autoreverses = true
        b.repeatCount = .infinity
        b.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        halo.add(b, forKey: "breath")
    }
}

// MARK: - Compact views (SwiftUI)

struct NotchCompactLeading: View {
    @ObservedObject var controller: NotchController
    var body: some View {
        ZStack {
            // Full-area glow so when state != idle the warm light fills the
            // notch instead of being clipped to a tiny square shadow around
            // a 10×10 dot. Painted as a radial gradient on the leading half
            // (NotchCompactTrailing paints the trailing half) — together
            // they tint the entire pill.
            NotchGlowFill(state: controller.state, side: .leading)
            HStack(spacing: 0) {
                NotchDot(active: controller.state != .idle)
                    .frame(width: 10, height: 10)
                    .padding(.leading, 6)
                Color.clear.frame(maxWidth: .infinity, minHeight: 24)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { controller.expandWithFocus(.chat) }
    }
}

/// Empty trailing — the native notch now shows a single compact icon,
/// matching the dashboard mirror. The leading slot owns the whole compact
/// interaction; the trailing side just takes clicks so the whole pill still
/// feels tappable.
struct NotchCompactTrailing: View {
    @ObservedObject var controller: NotchController
    var body: some View {
        NotchGlowFill(state: controller.state, side: .trailing)
            .frame(maxWidth: .infinity, minHeight: 24)
            .contentShape(Rectangle())
            .onTapGesture { controller.expandWithFocus(.chat) }
    }
}

/// Radial-gradient fill that tints the whole compact slot with a state-aware
/// glow. Idle = transparent. Thinking = warm orange. Responding = cool white.
/// The gradient is anchored toward the notch cutout so leading + trailing
/// halves visually merge into one continuous halo around the cutout instead
/// of two squared boxes.
struct NotchGlowFill: View {
    enum Side { case leading, trailing }
    let state: NotchAgentState
    let side: Side

    private var color: Color? {
        switch state {
        case .idle: return nil
        case .thinking: return Color(red: 1.00, green: 0.65, blue: 0.20)
        case .responding: return Color(red: 0.78, green: 0.88, blue: 1.00)
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let breath: Double = state == .idle ? 0 : 0.55 + 0.25 * (0.5 + 0.5 * sin(t * 2.4))
            Canvas { ctx, size in
                guard let c = color else { return }
                let rect = CGRect(origin: .zero, size: size)
                // Anchor toward the side that touches the cutout — leading
                // glow originates from its right edge, trailing from its
                // left, so the two halves merge seamlessly across the notch.
                let anchor = CGPoint(
                    x: side == .leading ? rect.maxX : rect.minX,
                    y: rect.midY
                )
                let r = max(rect.width, rect.height) * 1.4
                let grad = Gradient(stops: [
                    .init(color: c.opacity(0.95 * breath), location: 0.0),
                    .init(color: c.opacity(0.55 * breath), location: 0.25),
                    .init(color: c.opacity(0.20 * breath), location: 0.55),
                    .init(color: c.opacity(0.0),           location: 1.0),
                ])
                ctx.fill(
                    Path(rect),
                    with: .radialGradient(grad, center: anchor, startRadius: 0, endRadius: r)
                )
            }
            .allowsHitTesting(false)
        }
    }
}

/// Small glowing circle used as the unified compact indicator. Pulses
/// subtly when the agent is doing something (thinking / responding).
struct NotchDot: View {
    let active: Bool
    @State private var pulse: Double = 0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let breathe = active ? 0.6 + 0.4 * (0.5 + 0.5 * sin(t * 3.0)) : 0.85
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(red: 1.00, green: 0.78, blue: 0.40),
                            Color(red: 1.00, green: 0.55, blue: 0.20),
                        ],
                        center: .init(x: 0.35, y: 0.35),
                        startRadius: 0.5,
                        endRadius: 6
                    )
                )
                .shadow(color: Color(red: 1.00, green: 0.70, blue: 0.30).opacity(breathe), radius: 4)
        }
    }
}

// MARK: - Expanded view (SwiftUI)

struct NotchExpandedView: View {
    @ObservedObject var controller: NotchController

    var body: some View {
        SharedWebContainer(webView: controller.webView)
            .frame(width: 420, height: 540)
            .background(.clear)
            .cornerRadius(22)
    }
}

/// NSViewRepresentable that re-parents the SHARED WKWebView into the
/// container the moment the expanded view appears. No re-init, no black
/// flash: the WebGL context was already warm inside the preload window.
struct SharedWebContainer: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.clear.cgColor
        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        if webView.superview !== nsView {
            webView.removeFromSuperview()
            nsView.addSubview(webView)
        }
        webView.frame = nsView.bounds
        webView.autoresizingMask = [.width, .height]
    }
}
