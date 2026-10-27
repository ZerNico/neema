import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

/// What the latest look was of. Actions go to it; node ids name its elements.
private struct Looked {
  let app: NSRunningApplication
  let window: AXUIElement
  let windowNumber: CGWindowID
}

// One request at a time, in arrival order, so an action never races the look it refers to.
actor Driver {
  private let snapshot = Snapshot()
  private var looked: Looked?

  func handle(_ line: String) async {
    guard let data = line.data(using: .utf8),
      let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let id = request["id"], let method = request["method"] as? String
    else {
      send(["id": NSNull(), "error": ["code": "bad_request", "message": "Not a request"]])
      return
    }
    let params = request["params"] as? [String: Any] ?? [:]
    do {
      send(["id": id, "result": try await run(method, params)])
    } catch let error as DriverError {
      send(["id": id, "error": ["code": error.code, "message": error.message]])
    } catch {
      send(["id": id, "error": ["code": "failed", "message": "\(error)"]])
    }
  }

  private func run(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
    switch method {
    case "permissions":
      return [
        "accessibility": AXIsProcessTrusted(),
        "capture": CGPreflightScreenCaptureAccess(),
        "background": SkyLight.available,
      ]
    case "apps":
      return ["apps": listApps()]
    case "guide":
      guard let permission = Permission(rawValue: try param(params, "permission", as: String.self))
      else { throw DriverError(code: "invalid_params", message: "Unknown permission") }
      let bundle = URL(fileURLWithPath: try param(params, "bundle", as: String.self))
      let title = try param(params, "title", as: String.self)
      let instruction = try param(params, "instruction", as: String.self)
      let outcome = await PermissionGuide.shared.run(
        permission, bundle: bundle, title: title, instruction: instruction,
        preview: params["preview"] as? Bool ?? false,
        ticket: params["ticket"] as? Int ?? GuideTickets.shared.issue())
      return ["outcome": outcome]
    case "resolve":
      return try resolve(try param(params, "app", as: String.self))
    case "open":
      return try await open(try param(params, "appId", as: String.self))
    case "look":
      return try await look(
        try param(params, "appId", as: String.self), pid: (params["pid"] as? Int).map(pid_t.init))
    case "zoom":
      return try await zoom(try rect(params, "region"))
    case "click":
      try await clickAction(params)
      return [:]
    case "setValue":
      let element = try node(params)
      let result = AXUIElementSetAttributeValue(
        element, kAXValueAttribute as CFString,
        try param(params, "value", as: String.self) as CFString)
      guard result == .success else {
        throw DriverError(code: "action_failed", message: "That value cannot be set (\(result.rawValue))")
      }
      return [:]
    case "type":
      let target = try current()
      let text = try param(params, "text", as: String.self)
      var field: AXUIElement?
      if params["node"] != nil {
        field = try node(params)
        AXUIElementSetAttributeValue(field!, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      } else if let looked {
        field = attribute(appElement(looked.app), kAXFocusedUIElementAttribute)
      }
      // A native text field takes the text at its cursor in one step, exactly as given: typed
      // key by key, TextEdit's autocorrect and capitals rewrote it, and keys the person pressed
      // meanwhile mixed in. A page ignores text set this way, so it is typed there.
      if let field, !isWebField(field), insert(text, into: field) { return ["inserted": true] }
      type(text, pid: target.pid)
      return ["inserted": false]
    case "key":
      press(try parseChord(try param(params, "keys", as: String.self)), pid: try current().pid)
      return [:]
    case "scroll":
      let lines = (
        x: Int32(params["x"] as? Int ?? 0), y: Int32(params["y"] as? Int ?? 0)
      )
      try scroll(try current(), at: try point(params, "at"), lines: lines)
      return [:]
    case "drag":
      try drag(try current(), from: try point(params, "from"), to: try point(params, "to"))
      return [:]
    default:
      throw DriverError(code: "unknown_method", message: "No method \(method)")
    }
  }

  /// Inserts at the field's cursor, replacing its selection, if the field allows it.
  private func insert(_ text: String, into field: AXUIElement) -> Bool {
    var settable = DarwinBoolean(false)
    guard
      AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute as CFString, &settable)
        == .success, settable.boolValue
    else { return false }
    return AXUIElementSetAttributeValue(field, kAXSelectedTextAttribute as CFString, text as CFString)
      == .success
  }

  /// A field inside a web page, which ignores text set through accessibility.
  private func isWebField(_ field: AXUIElement) -> Bool {
    var element: AXUIElement? = field
    for _ in 0..<40 {
      guard let current = element else { return false }
      if attribute(current, kAXRoleAttribute, as: String.self) == "AXWebArea" { return true }
      element = attribute(current, kAXParentAttribute)
    }
    return false
  }

  private func open(_ appId: String) async throws -> [String: Any] {
    guard
      let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: appId)
        ?? installedApp(named: appId)
    else { throw DriverError(code: "not_installed", message: "\(appId) is not installed") }
    if isOffLimits(Bundle(url: url)?.bundleIdentifier) {
      throw DriverError(code: "off_limits", message: "\(appId) is never used")
    }
    let configuration = NSWorkspace.OpenConfiguration()
    // Opened behind the person's work, like everything else app use does.
    configuration.activates = false
    let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
    // An app is launched before its first window exists, and a look right away found none.
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline, (try? mainWindow(app)) == nil {
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    return [
      "name": app.localizedName ?? appId, "pid": Int(app.processIdentifier),
      "appId": app.bundleIdentifier ?? appId,
    ]
  }

  /// Which app a bundle id or name means, without starting it: what consent is asked about.
  private func resolve(_ app: String) throws -> [String: Any] {
    let running = NSWorkspace.shared.runningApplications.filter {
      $0.activationPolicy == .regular && !$0.isTerminated && !isOffLimits($0)
    }
    if let found = running.first(where: {
      $0.bundleIdentifier == app || $0.localizedName?.caseInsensitiveCompare(app) == .orderedSame
    }), let id = found.bundleIdentifier {
      return ["appId": id, "name": found.localizedName ?? id, "running": true]
    }
    guard
      let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: app)
        ?? installedApp(named: app),
      let bundle = Bundle(url: url), let id = bundle.bundleIdentifier
    else { throw DriverError(code: "not_installed", message: "\(app) is not installed") }
    if isOffLimits(id) { throw DriverError(code: "off_limits", message: "\(app) is never used") }
    let name =
      bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
      ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
      ?? url.deletingPathExtension().lastPathComponent
    return ["appId": id, "name": name, "running": false]
  }

  /// An app by the name a person calls it, where macOS keeps apps.
  private func installedApp(named name: String) -> URL? {
    let wanted = name.lowercased().replacingOccurrences(of: ".app", with: "") + ".app"
    let folders = [
      "/Applications", "/System/Applications", "/System/Applications/Utilities",
      "/Applications/Utilities", NSHomeDirectory() + "/Applications",
    ]
    for folder in folders {
      let names = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
      if let found = names.first(where: { $0.lowercased() == wanted }) {
        return URL(fileURLWithPath: folder).appendingPathComponent(found)
      }
    }
    return nil
  }

  private func look(_ appId: String, pid: pid_t?) async throws -> [String: Any] {
    let app = try runningApp(appId, pid: pid)
    let window = try mainWindow(app)
    await MainActor.run { enableWebContent(app, window: window) }
    let box = frame(window)
    let tree = snapshot.take(window: window, pid: app.processIdentifier)
    let number = try windowNumber(pid: app.processIdentifier, frame: box)
    let picture = try await capture(window: number, size: box?.size ?? .zero)
    looked = Looked(app: app, window: window, windowNumber: number)
    return [
      "app": app.localizedName ?? appId,
      "title": attribute(window, kAXTitleAttribute, as: String.self) ?? NSNull(),
      "window": ["width": box?.width ?? 0, "height": box?.height ?? 0],
      "image": [
        "data": picture.png.base64EncodedString(), "width": picture.width,
        "height": picture.height,
      ],
      "nodes": tree.nodes,
      "truncated": tree.truncated,
    ]
  }

  private func zoom(_ region: CGRect) async throws -> [String: Any] {
    guard let looked else { throw DriverError(code: "no_look", message: "Look at the app first") }
    let picture = try await capture(
      window: looked.windowNumber, size: frame(looked.window)?.size ?? .zero, region: region)
    return [
      "data": picture.png.base64EncodedString(), "width": picture.width,
      "height": picture.height,
    ]
  }

  private func clickAction(_ params: [String: Any]) async throws {
    let button: CGMouseButton =
      switch params["button"] as? String {
      case "right": .right
      case "middle": .center
      default: .left
      }
    let count = min(max(params["count"] as? Int ?? 1, 1), 3)
    var flags: CGEventFlags = []
    for name in params["modifiers"] as? [String] ?? [] {
      flags.formUnion(try parseChord("\(name)+a").flags)
    }
    // A plain click on an element that can be pressed is a press: no pointer at all. On a
    // Chromium page too: its pointer route needs a click stamped from before the window was shown,
    // and a page that then navigates in place (a router's link) crashes on that time (measured).
    if let id = params["node"] as? String, button == .left, count == 1, flags.isEmpty {
      let target = try current()
      if target.chromium, snapshot.webNodes.contains(id), let looked {
        let ready = await MainActor.run { webPressesWork(looked.app) }.timeIntervalSinceNow
        if ready > 0 { try await Task.sleep(for: .seconds(ready)) }
      }
      let element = try node(params)
      if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return }
    }
    try click(try current(), at: try point(params, "at"), button: button, count: count, flags: flags)
  }

  /// The window to send input to, where it is now: it may have moved since the look.
  private func current() throws -> Target {
    guard let looked, !looked.app.isTerminated else {
      throw DriverError(code: "no_look", message: "Look at the app first")
    }
    guard !isOffLimits(looked.app) else {
      throw DriverError(code: "off_limits", message: "That app is never used")
    }
    guard let box = frame(looked.window) else {
      throw DriverError(code: "no_window", message: "The window is gone")
    }
    return Target(
      pid: looked.app.processIdentifier, window: looked.windowNumber, frame: box,
      chromium: isChromium(looked.app))
  }

  private func node(_ params: [String: Any]) throws -> AXUIElement {
    let id = try param(params, "node", as: String.self)
    guard let element = snapshot.elements[id] else {
      throw DriverError(code: "stale_node", message: "\(id) is not in the latest look")
    }
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    guard pid == snapshot.pid, let owner = NSRunningApplication(processIdentifier: pid),
      !isOffLimits(owner)
    else { throw DriverError(code: "off_limits", message: "\(id) left the app") }
    return element
  }

  /// A point in window points: given, or the centre of the request's node.
  private func point(_ params: [String: Any], _ key: String) throws -> CGPoint {
    if let given = params[key] as? [String: Any], let x = given["x"] as? Double,
      let y = given["y"] as? Double
    {
      return CGPoint(x: x, y: y)
    }
    if let id = (params[key] as? [String: Any])?["node"] as? String ?? params["node"] as? String {
      let element = try node(["node": id])
      let window = try current().frame
      guard let box = frame(element) else {
        throw DriverError(code: "no_frame", message: "\(id) has no position")
      }
      return CGPoint(x: box.midX - window.minX, y: box.midY - window.minY)
    }
    throw DriverError(code: "invalid_params", message: "Missing \(key)")
  }

  private func rect(_ params: [String: Any], _ key: String) throws -> CGRect {
    guard let value = params[key] as? [String: Any], let x = value["x"] as? Double,
      let y = value["y"] as? Double, let width = value["width"] as? Double,
      let height = value["height"] as? Double, width > 0, height > 0
    else { throw DriverError(code: "invalid_params", message: "Missing or invalid \(key)") }
    return CGRect(x: x, y: y, width: width, height: height)
  }
}

// ScreenCaptureKit asserts without a window server connection, which the shared application
// opens. Prohibited keeps the driver out of the Dock and the app switcher.
NSApplication.shared.setActivationPolicy(.prohibited)

let driver = Driver()
// Requests are read off the main thread: AppKit keeps the running-app list current through the
// main run loop, which therefore has to keep running.
// Each request runs after the one before, without the reader waiting for it: a call that never
// returns must not keep the driver from seeing its input close. That is how it learns the app
// that started it is gone, and an orphan once kept a wedged capture spinning for minutes.
Thread.detachNewThread {
  var previous: Task<Void, Never>?
  while let line = readLine() {
    var line = line
    if let data = line.data(using: .utf8),
      var request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    {
      switch request["method"] as? String {
      // A guide waits on the person, so closing it cannot queue behind it.
      case "cancelGuide":
        GuideTickets.shared.cancelAll()
        let id = request["id"] ?? NSNull()
        Task { @MainActor in
          PermissionGuide.shared.close("closed")
          send(["id": id, "result": [:] as [String: Any]])
        }
        continue
      case "guide":
        var params = request["params"] as? [String: Any] ?? [:]
        params["ticket"] = GuideTickets.shared.issue()
        request["params"] = params
        if let numbered = try? JSONSerialization.data(withJSONObject: request) {
          line = String(decoding: numbered, as: UTF8.self)
        }
      default: break
      }
    }
    let before = previous
    previous = Task {
      await before?.value
      await driver.handle(line)
    }
  }
  // What was asked before the input closed is answered, unless it is stuck. `_exit`, not `exit`:
  // exit's cleanup waited on a lock a stuck capture held, and the orphan lived on.
  let last = previous
  Task {
    await last?.value
    _exit(0)
  }
  Thread.sleep(forTimeInterval: 2)
  _exit(0)
}
RunLoop.main.run()
