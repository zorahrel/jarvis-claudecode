import AppKit
import QuartzCore

/// Quarter-circle backdrop with an X glyph in the bottom-right corner of
/// the screen. Visible while the mic is recording so the user has a
/// concrete target for the "cancel by snapping to corner" gesture instead
/// of the previous magic-zone behaviour.
///
/// Driven by `setProximity(0...1)` from `NotchController`:
///   - 0   → idle (low alpha, gentle red, X slightly transparent)
///   - 0.5 → engaged (more opaque, pulsing X)
///   - 1   → committed (full red, X solid, ready to abort on release)
@MainActor
final class CancelAffordanceView: NSView {
    /// Single container that holds the disc + X + pulse. Its
    /// `anchorPoint` is the bottom-right corner of the panel, so when we
    /// scale it down to ~0 the whole affordance shrinks toward the corner
    /// instead of the layer center (which was pushing pixels off the
    /// top/left edges and getting clipped by the panel bounds).
    private let containerLayer = CALayer()
    private let backdropLayer = CAShapeLayer()
    private let xLayer = CAShapeLayer()
    private let pulseLayer = CAShapeLayer()

    private var proximity: CGFloat = 0
    /// Whether there is currently something cancellable (voice recording,
    /// agent reply, TTS playback). When false, the whole affordance fades
    /// to invisible — at rest the corner shows nothing. When true, the
    /// baseline state appears and proximity ramps it up further.
    private var isActive: Bool = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.masksToBounds = false

        containerLayer.anchorPoint = CGPoint(x: 1, y: 0)
        containerLayer.masksToBounds = false
        layer?.addSublayer(containerLayer)
        containerLayer.addSublayer(backdropLayer)
        containerLayer.addSublayer(pulseLayer)
        containerLayer.addSublayer(xLayer)

        rebuildPaths()
        applyProximity(animated: false)
    }

    required init?(coder: NSCoder) { fatalError("not implemented") }

    override func layout() {
        super.layout()
        rebuildPaths()
    }

    /// Update the backdrop / X / pulse paths to current bounds. Called on
    /// init, layout, and whenever the panel's frame changes.
    private func rebuildPaths() {
        let b = bounds
        guard b.width > 0, b.height > 0 else { return }

        // Container fills the whole panel. anchor at bottom-right means
        // its `position` must be (b.maxX, b.minY) to keep it in place.
        containerLayer.frame = b
        containerLayer.position = CGPoint(x: b.maxX, y: b.minY)
        // Back to a default 0,0 origin for child paths since the container
        // is what gets scaled — children draw relative to container bounds.
        containerLayer.bounds = CGRect(origin: .zero, size: b.size)

        // Disc whose centre sits at the screen's bottom-right corner =
        // `(b.width, 0)` in container-local coords. The full disc would
        // span `[b.width - radius, b.width + radius] × [-radius, radius]`,
        // but only the top-left quadrant (`x ≤ b.width`, `y ≥ 0`) is
        // inside the panel — that's the visible quarter-circle the user
        // wants. The other three quadrants are clipped by the NSWindow.
        let radius = min(b.width, b.height) * 0.85
        let diskRect = CGRect(
            x: b.width - radius,
            y: -radius,
            width: 2 * radius,
            height: 2 * radius
        )
        let disk = CGPath(ellipseIn: diskRect, transform: nil)
        backdropLayer.frame = containerLayer.bounds
        backdropLayer.path = disk
        backdropLayer.fillColor = NSColor.systemRed.withAlphaComponent(0.18).cgColor

        pulseLayer.frame = containerLayer.bounds
        pulseLayer.path = disk
        pulseLayer.fillColor = NSColor.clear.cgColor
        pulseLayer.strokeColor = NSColor.systemRed.withAlphaComponent(0.65).cgColor
        pulseLayer.lineWidth = 2
        pulseLayer.opacity = 0
        // Pulse scales around the bottom-right corner (where the disc
        // centre is) so the heartbeat doesn't drift up-left.
        pulseLayer.anchorPoint = CGPoint(x: 1, y: 0)
        pulseLayer.position = CGPoint(x: containerLayer.bounds.width, y: 0)

        // Centre the X inside the VISIBLE quadrant (top-left quarter of
        // the full disc) but biased slightly toward the screen corner so
        // it reads as "exit toward the corner".
        let xCx = b.width - radius * 0.35
        let xCy = radius * 0.35
        let xLen: CGFloat = radius * 0.13
        let path = CGMutablePath()
        path.move(to: CGPoint(x: xCx - xLen, y: xCy - xLen))
        path.addLine(to: CGPoint(x: xCx + xLen, y: xCy + xLen))
        path.move(to: CGPoint(x: xCx - xLen, y: xCy + xLen))
        path.addLine(to: CGPoint(x: xCx + xLen, y: xCy - xLen))
        xLayer.frame = containerLayer.bounds
        xLayer.path = path
        xLayer.strokeColor = NSColor.white.withAlphaComponent(0.92).cgColor
        xLayer.fillColor = NSColor.clear.cgColor
        xLayer.lineWidth = 3
        xLayer.lineCap = .round
    }

    func setProximity(_ raw: CGFloat) {
        let clamped = max(0, min(1, raw))
        guard abs(clamped - proximity) > 0.005 else { return }
        proximity = clamped
        applyProximity(animated: true)
    }

    func setActive(_ active: Bool) {
        guard active != isActive else { return }
        isActive = active
        applyProximity(animated: true)
    }

    private func applyProximity(animated: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(!animated)
        CATransaction.setAnimationDuration(0.22)

        // When NOT active (nothing to cancel) the whole affordance fades
        // to invisible. When active, it shows a baseline state at the
        // corner that the user can ramp up by approaching.
        layer?.opacity = isActive ? 1 : 0

        // Small but always-visible baseline when active. Grows smoothly
        // and proportionally to proximity (cubic-out so the early travel
        // moves it noticeably without overshooting at the corner).
        let baseline: CGFloat = isActive ? 0.20 : 0
        let scale = baseline + (1 - baseline) * proximity
        let eased = 1 - pow(1 - scale, 3)
        containerLayer.transform = CATransform3DMakeScale(eased, eased, 1)

        let backdropAlpha = (isActive ? 0.18 : 0.0) + 0.55 * proximity
        backdropLayer.fillColor = NSColor.systemRed.withAlphaComponent(backdropAlpha).cgColor
        xLayer.opacity = Float(isActive ? min(1, 0.55 + proximity * 0.45) : 0)

        // Pulse: a slow heartbeat ring that kicks in once we're committed
        // enough to bother showing it. Faster as we approach the corner.
        if proximity > 0.10 {
            pulseLayer.opacity = Float(0.4 + 0.6 * proximity)
            attachPulseAnimation(speed: 1.6 - 1.0 * proximity)
        } else {
            pulseLayer.opacity = 0
            pulseLayer.removeAllAnimations()
        }

        CATransaction.commit()
    }

    private func attachPulseAnimation(speed: CGFloat) {
        if pulseLayer.animation(forKey: "pulse") != nil { return }
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.92
        scale.toValue = 1.04
        scale.duration = max(0.45, Double(speed))
        scale.autoreverses = true
        scale.repeatCount = .infinity
        scale.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        pulseLayer.add(scale, forKey: "pulse")
    }
}
