import AppKit
import ApplicationServices

func listApps() -> [[String: Any]] {
  let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
  return NSWorkspace.shared.runningApplications
    // Apps without a bundle id cannot be named in a request, so they are not listed.
    .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }
    .map { app in
      [
        "appId": app.bundleIdentifier ?? "",
        "name": app.localizedName ?? app.bundleIdentifier ?? "",
        "pid": Int(app.processIdentifier),
        "front": app.processIdentifier == front,
        "offLimits": isOffLimits(app),
      ]
    }
}

/// The running app by bundle id. `pid` picks one instance where several share it, as
/// Electron apps in development do.
func runningApp(_ bundleId: String, pid: pid_t? = nil) throws -> NSRunningApplication {
  if isOffLimits(bundleId) {
    throw DriverError(code: "off_limits", message: "\(bundleId) is never used")
  }
  let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
    .filter { !$0.isTerminated && (pid == nil || $0.processIdentifier == pid) }
  if running.contains(where: isOffLimits), running.count == 1 {
    throw DriverError(code: "off_limits", message: "\(bundleId) is never used")
  }
  guard let app = running.first(where: { !isOffLimits($0) }) else {
    throw DriverError(code: "not_running", message: "\(bundleId) is not running")
  }
  return app
}

func attribute<T>(_ element: AXUIElement, _ name: String, as type: T.Type = T.self) -> T? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
    return nil
  }
  return value as? T
}

func point(_ element: AXUIElement, _ name: String) -> CGPoint? {
  guard let value: AXValue = attribute(element, name) else { return nil }
  var result = CGPoint.zero
  return AXValueGetValue(value, .cgPoint, &result) ? result : nil
}

func size(_ element: AXUIElement, _ name: String) -> CGSize? {
  guard let value: AXValue = attribute(element, name) else { return nil }
  var result = CGSize.zero
  return AXValueGetValue(value, .cgSize, &result) ? result : nil
}

func frame(_ element: AXUIElement) -> CGRect? {
  guard let origin = point(element, kAXPositionAttribute),
    let extent = size(element, kAXSizeAttribute)
  else { return nil }
  return CGRect(origin: origin, size: extent)
}

func appElement(_ app: NSRunningApplication) -> AXUIElement {
  let element = AXUIElementCreateApplication(app.processIdentifier)
  // A hung app would otherwise hold every call for the system's six seconds.
  AXUIElementSetMessagingTimeout(element, 1.5)
  return element
}

/// When each process's web content was last asked for, by pid and launch, since pids are reused.
@MainActor private var asked: [String: Date] = [:]

private func launchKey(_ app: NSRunningApplication) -> String {
  "\(app.processIdentifier):\(app.launchDate?.timeIntervalSince1970 ?? 0)"
}

/// Chromium apps (Chrome, Electron) leave their page out of the tree until an assistive client
/// asks for it. Reading the application's role turns native accessibility on at once, as Apple
/// advises for assistive tools other than VoiceOver and Chromium implements. The two switches
/// follow for builds that still need them: Chrome takes AXEnhancedUserInterface only after two
/// quiet seconds and restarts that wait whenever anything flips it, as window managers do, so
/// the request is repeated once. On the main thread: the page arrives only while the asking
/// thread's run loop turns (measured).
@MainActor
func enableWebContent(_ app: NSRunningApplication, window: AXUIElement) {
  let key = launchKey(app)
  guard asked[key] == nil, isChromium(app) else { return }
  let element = appElement(app)
  let ask = {
    asked[key] = Date()
    _ = attribute(element, kAXRoleAttribute, as: String.self)
    AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(element, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  }
  ask()
  let start = Date()
  var askedAgain = false
  while Date().timeIntervalSince(start) < 5, !hasPopulatedWebArea(window) {
    if !askedAgain, Date().timeIntervalSince(start) > 2.5 {
      ask()
      askedAgain = true
    }
    CFRunLoopRunInMode(.defaultMode, 0.1, false)
  }
}

/// When a press on the page starts to work: Chromium answers one with success and does nothing
/// until its two quiet seconds after the last request have passed (measured).
@MainActor
func webPressesWork(_ app: NSRunningApplication) -> Date {
  asked[launchKey(app)].map { $0.addingTimeInterval(2.5) } ?? .distantPast
}

func isChromium(_ app: NSRunningApplication) -> Bool {
  guard let frameworks = app.bundleURL?.appendingPathComponent("Contents/Frameworks"),
    let names = try? FileManager.default.contentsOfDirectory(atPath: frameworks.path)
  else { return false }
  return names.contains { $0.hasSuffix(".framework") && ($0.contains("Electron") || $0.contains("Chrom")) }
}

private func hasPopulatedWebArea(_ root: AXUIElement) -> Bool {
  var queue: [(AXUIElement, Int)] = [(root, 0)]
  var visits = 0
  while !queue.isEmpty, visits < 400 {
    let (element, depth) = queue.removeFirst()
    visits += 1
    let children: [AXUIElement] = attribute(element, kAXChildrenAttribute) ?? []
    if attribute(element, kAXRoleAttribute, as: String.self) == "AXWebArea" {
      if !children.isEmpty { return true }
      continue
    }
    if depth < 12 { queue.append(contentsOf: children.map { ($0, depth + 1) }) }
  }
  return false
}

// The window a look is of: the app's main window, else its focused one, else its first.
/// The window a look is of: the app's main window, else its focused one, else its largest. Each
/// must really be a window: with an alert open, Electron named an element containing itself.
/// A sheet or alert of the window shows inside it.
func mainWindow(_ app: NSRunningApplication) throws -> AXUIElement {
  let element = appElement(app)
  let isWindow = { (window: AXUIElement) in
    attribute(window, kAXRoleAttribute, as: String.self) == kAXWindowRole
  }
  for key in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
    if let window: AXUIElement = attribute(element, key), isWindow(window),
      (frame(window)?.width ?? 0) > 1
    {
      return window
    }
  }
  let windows: [AXUIElement] = attribute(element, kAXWindowsAttribute) ?? []
  if let largest = windows.filter(isWindow).max(by: { area($0) < area($1) }) { return largest }
  throw DriverError(code: "no_window", message: "\(app.localizedName ?? "The app") has no window")
}

private func area(_ window: AXUIElement) -> CGFloat {
  frame(window).map { $0.width * $0.height } ?? 0
}
