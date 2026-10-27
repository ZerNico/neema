import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

/// What the latest look was of. Actions go to it; node ids name its elements.
private struct Looked {
  let app: NSRunningApplication
  let window: AXUIElement
  let shareable: SCWindow
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
    case "open":
      return try await open(try param(params, "appId", as: String.self))
    case "look":
      return try await look(try param(params, "appId", as: String.self))
    case "zoom":
      return try await zoom(try rect(params, "region"))
    case "click":
      try clickAction(params)
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
      if params["node"] != nil {
        AXUIElementSetAttributeValue(try node(params), kAXFocusedAttribute as CFString, kCFBooleanTrue)
      }
      type(try param(params, "text", as: String.self), pid: target.pid)
      return [:]
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

  private func open(_ appId: String) async throws -> [String: Any] {
    if isOffLimits(appId) {
      throw DriverError(code: "off_limits", message: "\(appId) is never used")
    }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: appId) else {
      throw DriverError(code: "not_installed", message: "\(appId) is not installed")
    }
    let configuration = NSWorkspace.OpenConfiguration()
    // Opened behind the person's work, like everything else app use does.
    configuration.activates = false
    let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
    return ["name": app.localizedName ?? appId, "pid": Int(app.processIdentifier)]
  }

  private func look(_ appId: String) async throws -> [String: Any] {
    let app = try runningApp(appId)
    let window = try mainWindow(app)
    let box = frame(window)
    let tree = snapshot.take(window: window, pid: app.processIdentifier)
    let shareable = try await shareableWindow(pid: app.processIdentifier, frame: box)
    let picture = try await capture(shareable)
    looked = Looked(app: app, window: window, shareable: shareable)
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
    let picture = try await capture(looked.shareable, region: region)
    return [
      "data": picture.png.base64EncodedString(), "width": picture.width,
      "height": picture.height,
    ]
  }

  private func clickAction(_ params: [String: Any]) throws {
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
    // A plain click on an element that can be pressed is a press: no pointer at all.
    if params["node"] != nil, button == .left, count == 1, flags.isEmpty {
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
    guard !isOffLimits(looked.app.bundleIdentifier) else {
      throw DriverError(code: "off_limits", message: "That app is never used")
    }
    guard let box = frame(looked.window) else {
      throw DriverError(code: "no_window", message: "The window is gone")
    }
    return Target(pid: looked.app.processIdentifier, window: looked.shareable.windowID, frame: box)
  }

  private func node(_ params: [String: Any]) throws -> AXUIElement {
    let id = try param(params, "node", as: String.self)
    guard let element = snapshot.elements[id] else {
      throw DriverError(code: "stale_node", message: "\(id) is not in the latest look")
    }
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    guard pid == snapshot.pid, !isOffLimits(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier)
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
Thread.detachNewThread {
  while let line = readLine() {
    let done = DispatchSemaphore(value: 0)
    Task {
      await driver.handle(line)
      done.signal()
    }
    done.wait()
  }
  exit(0)
}
RunLoop.main.run()
