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

/// The window an AX window is, by the window server's list: its frame picks it among the app's,
/// else the largest. Public and served by the window server itself, so it answers when screen
/// capture does not.
func windowNumber(pid: pid_t, frame target: CGRect?) throws -> CGWindowID {
  let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
  let candidates = list.compactMap { info -> (CGWindowID, CGRect)? in
    guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid,
      (info[kCGWindowLayer as String] as? Int) == 0,
      let number = info[kCGWindowNumber as String] as? CGWindowID,
      let bounds = info[kCGWindowBounds as String] as? NSDictionary,
      let frame = CGRect(dictionaryRepresentation: bounds), frame.width > 1
    else { return nil }
    return (number, frame)
  }
  // AX and the window list both report top-left global points.
  let window =
    candidates.first { target != nil && $0.1.equalTo(target!) }
    ?? candidates.max { $0.1.width * $0.1.height < $1.1.width * $1.1.height }
  guard let window else { throw DriverError(code: "no_window", message: "No capturable window") }
  return window.0
}

/// One window by itself, covered or not, so nothing else on the screen is seen. With `region`
/// (window points), only that part, at the display's full resolution.
///
/// ScreenCaptureKit gets two seconds; then the window server's own copy of the window is read
/// through SkyLight, as cua-driver does for windows on another Space, where ScreenCaptureKit sees
/// nothing. Both go through replayd, which can stall (docs/internals/app-use.md), so neither
/// waits longer.
func capture(window: CGWindowID, size: CGSize, region: CGRect? = nil) async throws -> Capture {
  let image: CGImage
  do {
    image = try await withDeadline(seconds: 2) {
      try await screenCaptureKit(window: window, size: size, region: region)
    }
  } catch {
    // The same daemon can hold this up too, so it is bounded as well.
    guard let whole = try? await withDeadline(seconds: 3, { SkyLight.captureWindow(window) })
    else { throw error }
    image = try fitted(whole, size: size, region: region)
  }
  let bitmap = NSBitmapImageRep(cgImage: image)
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    throw DriverError(code: "capture_failed", message: "Could not encode the picture")
  }
  return Capture(png: png, width: image.width, height: image.height)
}

/// A picture scaled within `maxEdge` pixels, as PNG: a window's rounded corners stay clear, so
/// they take whatever the view shows the picture on. A JPEG turned them black.
func preview(_ image: CGImage, maxEdge: CGFloat) throws -> (data: Data, width: Int, height: Int) {
  let fit = max(CGFloat(max(image.width, image.height)) / maxEdge, 1)
  let width = max(1, Int((CGFloat(image.width) / fit).rounded()))
  let height = max(1, Int((CGFloat(image.height) / fit).rounded()))
  guard
    let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
  else { throw DriverError(code: "capture_failed", message: "Could not scale the picture") }
  context.interpolationQuality = .medium
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  guard let scaled = context.makeImage(),
    let data = NSBitmapImageRep(cgImage: scaled).representation(using: .png, properties: [:])
  else { throw DriverError(code: "capture_failed", message: "Could not encode the picture") }
  return (data, width, height)
}

/// The picture's size in pixels: a whole window at one pixel per point, a region at the
/// display's density, either fitted within `maxLookEdge`.
private func pictureSize(_ area: CGRect, density: CGFloat) -> CGSize {
  let pixels = CGSize(width: area.width * density, height: area.height * density)
  let fit = max(max(pixels.width, pixels.height) / maxLookEdge, 1)
  return CGSize(
    width: max(1, (pixels.width / fit).rounded()), height: max(1, (pixels.height / fit).rounded()))
}

private func screenCaptureKit(window number: CGWindowID, size: CGSize, region: CGRect?) async throws
  -> CGImage
{
  let content = try await SCShareableContent.excludingDesktopWindows(
    false, onScreenWindowsOnly: false)
  guard let window = content.windows.first(where: { $0.windowID == number }) else {
    throw DriverError(code: "no_window", message: "No capturable window")
  }
  let filter = SCContentFilter(desktopIndependentWindow: window)
  let area = region ?? CGRect(origin: .zero, size: size)
  let pixels = pictureSize(area, density: region == nil ? 1 : CGFloat(filter.pointPixelScale))
  let configuration = SCStreamConfiguration()
  if region != nil { configuration.sourceRect = area }
  configuration.width = Int(pixels.width)
  configuration.height = Int(pixels.height)
  configuration.showsCursor = false
  configuration.ignoreShadowsSingleWindow = true
  return try await SCScreenshotManager.captureImage(
    contentFilter: filter, configuration: configuration)
}

/// The window server's full-resolution copy, cropped to `region` and scaled as ScreenCaptureKit
/// would have delivered it.
private func fitted(_ whole: CGImage, size: CGSize, region: CGRect?) throws -> CGImage {
  let density = CGFloat(whole.width) / max(size.width, 1)
  var source = whole
  if let region {
    let crop = CGRect(
      x: region.minX * density, y: region.minY * density, width: region.width * density,
      height: region.height * density
    ).integral
    guard let cropped = whole.cropping(to: crop) else {
      throw DriverError(code: "capture_failed", message: "That part is outside the window")
    }
    source = cropped
  }
  let area = region ?? CGRect(origin: .zero, size: size)
  let pixels = pictureSize(area, density: region == nil ? 1 : density)
  guard
    let context = CGContext(
      data: nil, width: Int(pixels.width), height: Int(pixels.height), bitsPerComponent: 8,
      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw DriverError(code: "capture_failed", message: "Could not scale the picture") }
  context.interpolationQuality = .high
  context.draw(source, in: CGRect(origin: .zero, size: pixels))
  guard let image = context.makeImage() else {
    throw DriverError(code: "capture_failed", message: "Could not scale the picture")
  }
  return image
}

/// Resolves with the work's answer, or fails at the deadline, leaving work that never answers
/// unawaited: a task group would wait for it forever.
private func withDeadline<T>(seconds: Double, _ work: @escaping () async throws -> T) async throws
  -> T
{
  let settled = NSLock()
  var done = false
  let claim = { () -> Bool in
    settled.lock()
    defer { settled.unlock() }
    if done { return false }
    done = true
    return true
  }
  return try await withCheckedThrowingContinuation { continuation in
    Task {
      do {
        let value = try await work()
        if claim() { continuation.resume(returning: value) }
      } catch {
        if claim() { continuation.resume(throwing: error) }
      }
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
      if claim() {
        continuation.resume(
          throwing: DriverError(code: "capture_failed", message: "The screen capture did not answer"))
      }
    }
  }
}
