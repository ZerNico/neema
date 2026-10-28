import AppKit

/// The driver's own windows: the permission guide and neema's cursor. An app may only show
/// windows while it is allowed to, which also lists it where the system lists running apps, so
/// the driver allows it while one of them is up and goes back to none after the last.
@MainActor
enum Shown {
  private static var windows = 0

  static func hold() {
    windows += 1
    if windows == 1 { NSApplication.shared.setActivationPolicy(.accessory) }
  }

  static func release() {
    guard windows > 0 else { return }
    windows -= 1
    if windows == 0 { NSApplication.shared.setActivationPolicy(.prohibited) }
  }
}
