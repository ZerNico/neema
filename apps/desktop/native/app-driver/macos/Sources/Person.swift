import AppKit
import CoreGraphics

/// The person's own input wins. While they click, type or scroll in the app being used, its
/// actions wait for them, as Codex's helper answers that the user is still interacting with an
/// app. Read from the system's record of hardware input, which the driver's own events, posted
/// to one process, never enter (measured); no input is watched or kept.
enum Person {
  /// How long the person must have left the app alone before an action goes ahead.
  static let quiet: TimeInterval = 2.5

  private static let pointer: [CGEventType] = [
    .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .scrollWheel,
  ]

  /// How long to wait for the person in the target's app; zero when they are not using it.
  /// Keys count while the app is in front, where keys go; clicks and scrolls while its window
  /// is uppermost under the pointer, where they go. Typing in neema with the pointer resting on
  /// the app, or pressing Pause in neema's floating window above it, is not using the app.
  static func busy(in target: Target) -> TimeInterval {
    let keys = since([.keyDown])
    let clicks = since(pointer)
    var wait: TimeInterval = 0
    if keys < quiet, NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid {
      wait = quiet - keys
    }
    if clicks < quiet, let location = CGEvent(source: nil)?.location,
      owner(at: location) == target.pid
    {
      wait = max(wait, quiet - clicks)
    }
    return wait
  }

  private static func since(_ types: [CGEventType]) -> TimeInterval {
    types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min()
      ?? .infinity
  }

  /// The app a click at a screen point goes to: the owner of the uppermost window there, or the
  /// app in front over the menu bar, which is its. Nil over the Dock, a banner or the desktop.
  /// Floating windows count, as neema's floating view does; the driver's own cursor does not,
  /// as clicks pass through it.
  private static func owner(at point: CGPoint) -> pid_t? {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
      as? [[String: Any]] ?? []
    let menuBar = Int(CGWindowLevelForKey(.mainMenuWindow))
    // Front to back.
    for info in windows {
      guard let layer = info[kCGWindowLayer as String] as? Int, layer >= 0,
        let pid = info[kCGWindowOwnerPID as String] as? pid_t, pid != getpid(),
        let bounds = info[kCGWindowBounds as String] as? NSDictionary,
        let frame = CGRect(dictionaryRepresentation: bounds), frame.contains(point)
      else { continue }
      if layer < 20 { return pid }
      return layer == menuBar ? NSWorkspace.shared.frontmostApplication?.processIdentifier : nil
    }
    return nil
  }
}
