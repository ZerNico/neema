import AppKit

/// The privacy lists a guide leads the person through.
enum Permission: String {
  case accessibility
  case screenRecording

  var pane: URL {
    URL(
      string: "x-apple.systempreferences:com.apple.preference.security?"
        + (self == .accessibility ? "Privacy_Accessibility" : "Privacy_ScreenCapture"))!
  }

  /// Read live. CGPreflightScreenCaptureAccess keeps its first answer until the process ends,
  /// so a grant made meanwhile shows instead in other apps' window titles becoming readable.
  var granted: Bool {
    switch self {
    case .accessibility: return AXIsProcessTrusted()
    case .screenRecording:
      if CGPreflightScreenCaptureAccess() { return true }
      let own = ProcessInfo.processInfo.processIdentifier
      let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
        as? [[String: Any]] ?? []
      return windows.contains {
        ($0[kCGWindowOwnerPID as String] as? pid_t) != own
          && !(($0[kCGWindowName as String] as? String) ?? "").isEmpty
      }
    }
  }
}

private let settingsBundleId = "com.apple.systempreferences"

/// Guide requests numbered as the reader reads them, so a cancel ends every guide asked for
/// before it, also one that has not started yet: closing only what is on screen lost that race.
final class GuideTickets {
  static let shared = GuideTickets()
  private let lock = NSLock()
  private var issued = 0
  private var cancelledThrough = 0

  func issue() -> Int {
    lock.lock()
    defer { lock.unlock() }
    issued += 1
    return issued
  }

  func cancelAll() {
    lock.lock()
    defer { lock.unlock() }
    cancelledThrough = issued
  }

  func cancelled(_ ticket: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return ticket <= cancelledThrough
  }
}

/// neema's icon, dragged as its app bundle: a privacy list takes an app dropped onto it.
private final class DragIcon: NSView, NSDraggingSource {
  let bundle: URL
  let icon: NSImage

  init(bundle: URL) {
    self.bundle = bundle
    icon = NSWorkspace.shared.icon(forFile: bundle.path)
    super.init(frame: NSRect(x: 0, y: 0, width: 44, height: 44))
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ dirtyRect: NSRect) { icon.draw(in: bounds) }
  override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func mouseDown(with event: NSEvent) {
    let item = NSDraggingItem(pasteboardWriter: bundle as NSURL)
    item.setDraggingFrame(bounds, contents: icon)
    beginDraggingSession(with: [item], event: event, source: self)
  }

  func draggingSession(
    _ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext
  ) -> NSDragOperation { .copy }
}

/**
 * A small panel inside System Settings with neema's icon to drag into a privacy list. On macOS 26
 * the system's prompts no longer add a new app to Accessibility or Screen Recording, so the
 * person has to (measured by agent-desktop; LobeHub ships the same panel). It never takes focus,
 * follows the Settings window, and shows only while Settings is in front.
 */
@MainActor
final class PermissionGuide {
  static let shared = PermissionGuide()

  private var panel: NSPanel?
  private var timer: Timer?
  private var finish: ((String) -> Void)?

  /// Resolves "granted", "closed" (by the person or a cancel) or "timeout" after ten minutes.
  /// `preview` shows the panel whatever is granted, to check it by eye.
  func run(
    _ permission: Permission, bundle: URL, title: String, instruction: String, preview: Bool,
    ticket: Int
  ) async -> String {
    let granted = { !preview && permission.granted }
    if granted() { return "granted" }
    if GuideTickets.shared.cancelled(ticket) { return "closed" }
    close("closed")
    return await withCheckedContinuation { continuation in
      finish = { continuation.resume(returning: $0) }
      // Windows need an app that may show them; the driver goes back to none afterwards.
      NSApplication.shared.setActivationPolicy(.accessory)
      NSWorkspace.shared.open(permission.pane)
      // A running Settings is not raised by its link alone.
      NSRunningApplication.runningApplications(withBundleIdentifier: settingsBundleId).first?
        .activate()
      let panel = makePanel(bundle: bundle, title: title, instruction: instruction)
      self.panel = panel
      let started = Date()
      timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self else { return }
          if granted() { return self.close("granted") }
          if GuideTickets.shared.cancelled(ticket) { return self.close("closed") }
          if Date().timeIntervalSince(started) > 600 { return self.close("timeout") }
          self.place(panel)
        }
      }
      place(panel)
    }
  }

  func close(_ outcome: String) {
    timer?.invalidate()
    timer = nil
    panel?.orderOut(nil)
    panel = nil
    if let finish {
      self.finish = nil
      NSApplication.shared.setActivationPolicy(.prohibited)
      finish(outcome)
    }
  }

  private func makePanel(bundle: URL, title: String, instruction: String) -> NSPanel {
    let size = NSSize(width: 380, height: 68)
    let panel = NSPanel(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
      backing: .buffered, defer: false)
    panel.level = .floating
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true

    let background = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
    background.material = .popover
    background.state = .active
    background.wantsLayer = true
    background.layer?.cornerRadius = 14
    background.layer?.masksToBounds = true

    let icon = DragIcon(bundle: bundle)
    icon.frame.origin = NSPoint(x: 14, y: (size.height - 44) / 2)

    let heading = NSTextField(labelWithString: title)
    heading.font = .boldSystemFont(ofSize: 13)
    let line = NSTextField(labelWithString: instruction)
    line.font = .systemFont(ofSize: 12)
    line.textColor = .secondaryLabelColor
    let text = NSStackView(views: [heading, line])
    text.orientation = .vertical
    text.alignment = .leading
    text.spacing = 2
    text.frame = NSRect(x: 70, y: 12, width: size.width - 70 - 40, height: size.height - 24)

    let dismiss = NSButton(
      image: NSImage(systemSymbolName: "xmark", accessibilityDescription: nil)!,
      target: self, action: #selector(closedByPerson))
    dismiss.isBordered = false
    dismiss.frame = NSRect(x: size.width - 32, y: (size.height - 20) / 2, width: 20, height: 20)

    background.addSubview(icon)
    background.addSubview(text)
    background.addSubview(dismiss)
    panel.contentView = background
    return panel
  }

  @objc private func closedByPerson() { close("closed") }

  /// Bottom centre of the Settings window, shown only while Settings is in front.
  private func place(_ panel: NSPanel) {
    let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    guard front == settingsBundleId, let window = settingsWindow(),
      let primary = NSScreen.screens.first
    else {
      panel.orderOut(nil)
      return
    }
    let size = panel.frame.size
    // Under the list, not the sidebar: Settings' sidebar is about 230 points on macOS 26. A
    // window too narrow for both gets the panel centred on it whole.
    let sidebar: CGFloat = window.width >= 230 + size.width ? 230 : 0
    let centre = window.minX + sidebar + (window.width - sidebar) / 2
    // The window list is top-left based; AppKit is bottom-left on the primary screen.
    let top = window.maxY - 16 - size.height
    let origin = NSPoint(x: centre - size.width / 2, y: primary.frame.height - top - size.height)
    panel.setFrameOrigin(origin)
    panel.orderFrontRegardless()
  }

  /// Bounds are in the window list without Screen Recording; titles are not, and are not needed.
  private func settingsWindow() -> CGRect? {
    guard
      let pid = NSRunningApplication.runningApplications(withBundleIdentifier: settingsBundleId)
        .first?.processIdentifier
    else { return nil }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
      as? [[String: Any]] ?? []
    return windows.compactMap { info -> CGRect? in
      guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid,
        (info[kCGWindowLayer as String] as? Int) == 0,
        let bounds = info[kCGWindowBounds as String] as? NSDictionary
      else { return nil }
      return CGRect(dictionaryRepresentation: bounds)
    }.max { $0.width * $0.height < $1.width * $1.height }
  }
}
