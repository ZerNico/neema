import AppKit
import ScreenCaptureKit

// The longest edge of a picture sent back. The desktop app scales between its pixels and window
// points from the sizes a look reports.
let maxLookEdge: CGFloat = 1280

struct Capture {
  let png: Data
  let width: Int
  let height: Int
}

/// The capturable window matching an AX window's frame, else the app's largest.
func shareableWindow(pid: pid_t, frame target: CGRect?) async throws -> SCWindow {
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
  return window
}

/// Captures one window by itself, covered or not, so nothing else on the screen is seen. With
/// `region` (window points), only that part, at the display's full resolution.
func capture(_ window: SCWindow, region: CGRect? = nil) async throws -> Capture {
  let area = region ?? CGRect(origin: .zero, size: window.frame.size)
  let filter = SCContentFilter(desktopIndependentWindow: window)
  // A region is for detail, so it starts at the backing resolution before fitting.
  let density = region == nil ? 1 : CGFloat(filter.pointPixelScale)
  let pixels = CGSize(width: area.width * density, height: area.height * density)
  let fit = max(max(pixels.width, pixels.height) / maxLookEdge, 1)
  let configuration = SCStreamConfiguration()
  if region != nil { configuration.sourceRect = area }
  configuration.width = max(1, Int((pixels.width / fit).rounded()))
  configuration.height = max(1, Int((pixels.height / fit).rounded()))
  configuration.showsCursor = false
  configuration.ignoreShadowsSingleWindow = true
  let image = try await SCScreenshotManager.captureImage(
    contentFilter: filter, configuration: configuration)
  let bitmap = NSBitmapImageRep(cgImage: image)
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    throw DriverError(code: "capture_failed", message: "Could not encode the picture")
  }
  return Capture(png: png, width: image.width, height: image.height)
}
