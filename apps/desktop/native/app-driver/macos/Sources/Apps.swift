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
        "offLimits": isOffLimits(app.bundleIdentifier),
      ]
    }
}

func runningApp(_ bundleId: String) throws -> NSRunningApplication {
  if isOffLimits(bundleId) {
    throw DriverError(code: "off_limits", message: "\(bundleId) is never used")
  }
  guard
    let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first(
      where: { !$0.isTerminated })
  else { throw DriverError(code: "not_running", message: "\(bundleId) is not running") }
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

// The window a look is of: the app's main window, else its focused one, else its first.
func mainWindow(_ app: NSRunningApplication) throws -> AXUIElement {
  let element = appElement(app)
  if let window: AXUIElement = attribute(element, kAXMainWindowAttribute) { return window }
  if let window: AXUIElement = attribute(element, kAXFocusedWindowAttribute) { return window }
  if let windows: [AXUIElement] = attribute(element, kAXWindowsAttribute), let first = windows.first
  {
    return first
  }
  throw DriverError(code: "no_window", message: "\(app.localizedName ?? "The app") has no window")
}
