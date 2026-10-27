import AppKit
import CoreGraphics

/// The window a look was of, which coordinate input goes to.
struct Target {
  let pid: pid_t
  let window: CGWindowID
  /// Global top-left points, as AX and CGEvent use them.
  let frame: CGRect
}

private func pause(_ milliseconds: UInt32) { usleep(milliseconds * 1000) }

private func gesture() -> Int64 { Int64(DispatchTime.now().uptimeNanoseconds & 0x7FFF_FFFF) }

/// A click at a point of the window, in window points, without raising it or moving the
/// person's cursor.
func click(
  _ target: Target, at local: CGPoint, button: CGMouseButton, count: Int, flags: CGEventFlags
) throws {
  let screen = CGPoint(x: target.frame.minX + local.x, y: target.frame.minY + local.y)
  let (down, up): (CGEventType, CGEventType) =
    switch button {
    case .right: (.rightMouseDown, .rightMouseUp)
    case .center: (.otherMouseDown, .otherMouseUp)
    default: (.leftMouseDown, .leftMouseUp)
    }
  let source = CGEventSource(stateID: .hidSystemState)
  let group = gesture()
  _ = SkyLight.focusWithoutRaise(pid: target.pid, window: target.window)
  // AppKit updates which window takes input before the events arrive.
  pause(50)
  // A background window hit-tests a press against where it last saw the cursor, so it first
  // sees the cursor arrive.
  if let move = CGEvent(
    mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: screen,
    mouseButton: .left)
  {
    SkyLight.postMouse(
      move, pid: target.pid, window: target.window, local: local, clickState: 0, button: 0,
      group: group)
  }
  pause(12)
  for index in 1...max(1, count) {
    for type in [down, up] {
      guard
        let event = CGEvent(
          mouseEventSource: source, mouseType: type, mouseCursorPosition: screen,
          mouseButton: button)
      else { throw DriverError(code: "action_failed", message: "Could not make a click") }
      event.flags = flags
      SkyLight.postMouse(
        event, pid: target.pid, window: target.window, local: local, clickState: Int64(index),
        button: Int64(button.rawValue), group: group)
      // A button's tracking loop polls for the release; too tight a gap drops the click.
      pause(type == down ? 28 : 0)
    }
    if index < count { pause(80) }
  }
}

/// Scrolls whatever is under a point of the window, by lines.
func scroll(_ target: Target, at local: CGPoint, lines: (x: Int32, y: Int32)) throws {
  let screen = CGPoint(x: target.frame.minX + local.x, y: target.frame.minY + local.y)
  let source = CGEventSource(stateID: .hidSystemState)
  let group = gesture()
  _ = SkyLight.focusWithoutRaise(pid: target.pid, window: target.window)
  pause(50)
  if let move = CGEvent(
    mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: screen,
    mouseButton: .left)
  {
    SkyLight.postMouse(
      move, pid: target.pid, window: target.window, local: local, clickState: 0, button: 0,
      group: group)
  }
  pause(12)
  // One event per line so apps animate each step instead of jumping. Positive y reveals what
  // is above, as a wheel does.
  let steps = max(abs(lines.x), abs(lines.y))
  for _ in 0..<steps {
    guard
      let event = CGEvent(
        scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
        wheel1: lines.y.signum(), wheel2: lines.x.signum(), wheel3: 0)
    else { throw DriverError(code: "action_failed", message: "Could not make a scroll") }
    event.location = screen
    SkyLight.postMouse(
      event, pid: target.pid, window: target.window, local: local, clickState: 0, button: 0,
      group: group)
    pause(30)
  }
}

/// Presses at one point of the window, moves in steps and releases at another.
func drag(_ target: Target, from start: CGPoint, to end: CGPoint) throws {
  let screen = { (local: CGPoint) in
    CGPoint(x: target.frame.minX + local.x, y: target.frame.minY + local.y)
  }
  let source = CGEventSource(stateID: .hidSystemState)
  let group = gesture()
  _ = SkyLight.focusWithoutRaise(pid: target.pid, window: target.window)
  pause(50)
  let post = { (type: CGEventType, local: CGPoint, clickState: Int64) in
    guard
      let event = CGEvent(
        mouseEventSource: source, mouseType: type, mouseCursorPosition: screen(local),
        mouseButton: .left)
    else { throw DriverError(code: "action_failed", message: "Could not make a drag") }
    SkyLight.postMouse(
      event, pid: target.pid, window: target.window, local: local, clickState: clickState,
      button: 0, group: group)
  }
  try post(.mouseMoved, start, 0)
  pause(12)
  try post(.leftMouseDown, start, 1)
  pause(40)
  let steps = 12
  for step in 1...steps {
    let t = CGFloat(step) / CGFloat(steps)
    let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
    try post(.leftMouseDragged, point, 1)
    pause(16)
  }
  try post(.leftMouseUp, end, 1)
}

/// Types text into the app's focused element. Keyboard events reach a background process
/// through the public route; only mouse events need the window server's private one.
func type(_ text: String, pid: pid_t) {
  let source = CGEventSource(stateID: .hidSystemState)
  for character in text {
    let units = Array(String(character).utf16)
    for down in [true, false] {
      guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
        continue
      }
      units.withUnsafeBufferPointer {
        event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress)
      }
      event.postToPid(pid)
    }
    pause(8)
  }
}

/// Presses a key with modifiers held, as one chord.
func press(_ chord: Chord, pid: pid_t) {
  let source = CGEventSource(stateID: .hidSystemState)
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: chord.key, keyDown: down)
    else { continue }
    event.flags = chord.flags
    event.postToPid(pid)
    pause(down ? 20 : 0)
  }
}
