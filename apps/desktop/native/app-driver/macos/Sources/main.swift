import AppKit
import ApplicationServices
import Foundation

// One request at a time, in arrival order, so an action never races the look it refers to.
actor Driver {
  private let snapshot = Snapshot()

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
      ]
    case "apps":
      return ["apps": listApps()]
    case "look":
      return try await look(try param(params, "appId", as: String.self))
    case "press":
      return try press(try param(params, "node", as: String.self))
    default:
      throw DriverError(code: "unknown_method", message: "No method \(method)")
    }
  }

  private func look(_ appId: String) async throws -> [String: Any] {
    let app = try runningApp(appId)
    let window = try mainWindow(app)
    let box = frame(window)
    let tree = snapshot.take(window: window, pid: app.processIdentifier)
    let picture = try await captureWindow(pid: app.processIdentifier, frame: box)
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

  private func press(_ node: String) throws -> [String: Any] {
    guard let element = snapshot.elements[node] else {
      throw DriverError(code: "stale_node", message: "\(node) is not in the latest look")
    }
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    guard pid == snapshot.pid,
      !isOffLimits(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier)
    else { throw DriverError(code: "off_limits", message: "\(node) left the app") }
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard result == .success else {
      throw DriverError(code: "action_failed", message: "Press failed (\(result.rawValue))")
    }
    return [:]
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
