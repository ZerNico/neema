import AppKit
import ScreenCaptureKit

// The longest edge of a look's picture. The desktop app scales between its pixels and window
// points from the sizes a look reports.
let maxLookEdge: CGFloat = 1280

struct Capture {
  let png: Data
  let width: Int
  let height: Int
}

// Captures one window by itself, covered or not, so nothing else on the screen is seen.
func captureWindow(pid: pid_t, frame target: CGRect?) async throws -> Capture {
  let content = try await SCShareableContent.excludingDesktopWindows(
    false, onScreenWindowsOnly: false)
  let candidates = content.windows.filter {
    $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 1
  }
  // AX and ScreenCaptureKit both report top-left global points, so the AX frame picks the window.
  let window =
    candidates.first { target != nil && $0.frame.equalTo(target!) }
    ?? candidates.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
  guard let window else {
    throw DriverError(code: "no_window", message: "No capturable window")
  }
  let points = window.frame.size
  let scale = max(points.width, points.height) / maxLookEdge
  let fit = max(scale, 1)
  let configuration = SCStreamConfiguration()
  configuration.width = Int((points.width / fit).rounded())
  configuration.height = Int((points.height / fit).rounded())
  configuration.showsCursor = false
  configuration.ignoreShadowsSingleWindow = true
  let image = try await SCScreenshotManager.captureImage(
    contentFilter: SCContentFilter(desktopIndependentWindow: window),
    configuration: configuration)
  let bitmap = NSBitmapImageRep(cgImage: image)
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    throw DriverError(code: "capture_failed", message: "Could not encode the picture")
  }
  return Capture(png: png, width: image.width, height: image.height)
}
