import AppKit
import QuartzCore

/// neema's own pointer, drawn where it acts so the person sees it work, as Codex's helper draws
/// its agent cursor. The person's pointer never moves. It glides to each point before acting,
/// pulses on a click and fades once neema rests. It sits just above the window it acts in, so
/// whatever covers that window covers it too, and it never takes clicks or focus.
@MainActor
final class Cursor {
  static let shared = Cursor()

  /// The panel is larger than the arrow, for its shadow and the pulse around its tip.
  private static let size = CGSize(width: 72, height: 72)
  private static let tip = CGPoint(x: 36, y: 36)
  private static let rest: TimeInterval = 1.6

  private var panel: NSPanel?
  private var view: CursorView?
  private var fade: Timer?

  /// Brings the cursor to a screen point (global, top-left) above a window, gliding there from
  /// where it was; returns once it arrived. Nothing shows for a window off screen.
  func move(to point: CGPoint, above window: CGWindowID) async {
    fade?.invalidate()
    guard onScreen(window) else { return hide() }
    let panel = self.panel ?? make()
    let origin = Self.origin(for: point)
    if !panel.isVisible {
      // It comes in from a little up and left, as a hand enters a page.
      panel.setFrameOrigin(NSPoint(x: origin.x - 24, y: origin.y + 18))
      panel.alphaValue = 0
      panel.order(.above, relativeTo: Int(window))
    } else {
      panel.order(.above, relativeTo: Int(window))
    }
    let distance = hypot(panel.frame.origin.x - origin.x, panel.frame.origin.y - origin.y)
    let duration =
      NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
      ? 0 : min(0.45, max(0.16, distance / 1800))
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      NSAnimationContext.runAnimationGroup { context in
        context.duration = duration
        context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        // A window animates its whole frame, not its origin alone.
        panel.animator().setFrame(NSRect(origin: origin, size: Self.size), display: true)
        panel.animator().alphaValue = 1
      } completionHandler: {
        done.resume()
      }
    }
  }

  /// A ring out of the tip, as the click lands.
  func press() {
    view?.pulse()
  }

  /// neema is done for now: the cursor fades unless it moves again soon.
  func settle() {
    fade?.invalidate()
    fade = Timer.scheduledTimer(withTimeInterval: Self.rest, repeats: false) { _ in
      MainActor.assumeIsolated { Cursor.shared.hide() }
    }
  }

  func hide() {
    fade?.invalidate()
    guard let panel else { return }
    self.panel = nil
    view = nil
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.25
      panel.animator().alphaValue = 0
    } completionHandler: {
      MainActor.assumeIsolated {
        panel.orderOut(nil)
        Shown.release()
      }
    }
  }

  private func make() -> NSPanel {
    Shown.hold()
    let panel = NSPanel(
      contentRect: NSRect(origin: .zero, size: Self.size),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.isReleasedWhenClosed = false
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
    let view = CursorView(frame: NSRect(origin: .zero, size: Self.size), tip: Self.tip)
    panel.contentView = view
    self.panel = panel
    self.view = view
    return panel
  }

  /// The panel's origin, in AppKit's bottom-left screen space, that puts the tip on a point.
  private static func origin(for point: CGPoint) -> NSPoint {
    let height = NSScreen.screens.first?.frame.height ?? 0
    return NSPoint(x: point.x - tip.x, y: height - point.y - (size.height - tip.y))
  }

  private func onScreen(_ window: CGWindowID) -> Bool {
    let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], window) as? [[String: Any]]
    return info?.first?[kCGWindowIsOnscreen as String] as? Bool ?? false
  }
}

/// An arrow in neema's colour with a light rim, readable on any app, and the ring of a press.
private final class CursorView: NSView {
  private let tip: CGPoint
  private let ring = CAShapeLayer()

  init(frame: NSRect, tip: CGPoint) {
    self.tip = tip
    super.init(frame: frame)
    wantsLayer = true
    let arrow = CAShapeLayer()
    arrow.path = Self.arrow(at: CGPoint(x: tip.x, y: frame.height - tip.y))
    arrow.fillColor = NSColor(srgbRed: 0.39, green: 0.32, blue: 0.9, alpha: 1).cgColor
    arrow.strokeColor = NSColor.white.cgColor
    arrow.lineWidth = 1.5
    arrow.lineJoin = .round
    arrow.shadowColor = NSColor.black.cgColor
    arrow.shadowOpacity = 0.3
    arrow.shadowRadius = 3
    arrow.shadowOffset = CGSize(width: 0, height: -1)
    ring.path = CGPath(
      ellipseIn: CGRect(x: tip.x - 14, y: frame.height - tip.y - 14, width: 28, height: 28),
      transform: nil)
    ring.fillColor = nil
    ring.strokeColor = arrow.fillColor
    ring.lineWidth = 2
    ring.opacity = 0
    ring.frame = bounds
    // Scaled about the tip, not the panel's corner.
    ring.anchorPoint = CGPoint(x: tip.x / bounds.width, y: 1 - tip.y / bounds.height)
    ring.position = CGPoint(x: tip.x, y: bounds.height - tip.y)
    layer?.addSublayer(ring)
    layer?.addSublayer(arrow)
  }

  required init?(coder: NSCoder) { nil }

  func pulse() {
    guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = 0.3
    grow.toValue = 1.3
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0.9
    fade.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [grow, fade]
    group.duration = 0.45
    group.timingFunction = CAMediaTimingFunction(name: .easeOut)
    ring.add(group, forKey: "pulse")
  }

  /// The classic pointer, its tip at `tip`, pointing up and left; y grows upward here.
  private static func arrow(at tip: CGPoint) -> CGPath {
    let path = CGMutablePath()
    let points: [(CGFloat, CGFloat)] = [
      (0, 0), (0, -17), (4.2, -13), (7, -19.5), (9.6, -18.4), (6.9, -12), (12.5, -12),
    ]
    path.move(to: CGPoint(x: tip.x + points[0].0, y: tip.y + points[0].1))
    for point in points.dropFirst() {
      path.addLine(to: CGPoint(x: tip.x + point.0, y: tip.y + point.1))
    }
    path.closeSubpath()
    return path
  }
}
