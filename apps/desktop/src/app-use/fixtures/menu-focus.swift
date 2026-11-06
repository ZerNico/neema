// Two roles for real-driver.test.ts. `front` stands in for the person's app: it comes forward
// with a field that holds the keys. `target` is the app neema works in behind it, with a pop-up
// button whose menu AppKit opens by stealing key focus from whichever app holds it. Each prints
// its state as a JSON line whenever it changes.
import AppKit

final class Delegate: NSObject, NSApplicationDelegate {
  let front = CommandLine.arguments.dropFirst().first == "front"
  let window = NSWindow(
    contentRect: NSRect(x: 200, y: 200, width: 360, height: 140), styleMask: [.titled],
    backing: .buffered, defer: false)
  let field = NSTextField(frame: NSRect(x: 20, y: 60, width: 320, height: 24))
  let popUp = NSPopUpButton(frame: NSRect(x: 20, y: 60, width: 200, height: 26))
  var menuOpen = false
  var last = ""

  func applicationDidFinishLaunching(_ notification: Notification) {
    window.title = front ? "Front" : "Target"
    if front {
      window.setFrameOrigin(NSPoint(x: 200, y: 200))
      field.placeholderString = "Person's field"
      window.contentView!.addSubview(field)
      window.makeKeyAndOrderFront(nil)
      window.makeFirstResponder(field)
      NSApp.activate(ignoringOtherApps: true)
    } else {
      window.setFrameOrigin(NSPoint(x: 620, y: 200))
      popUp.addItems(withTitles: ["One", "Two", "Three"])
      popUp.setAccessibilityLabel("Choice")
      window.contentView!.addSubview(popUp)
      let context = NSMenu()
      context.addItem(withTitle: "Context", action: nil, keyEquivalent: "")
      window.contentView!.menu = context
      window.orderFront(nil)
      for (name, open) in [
        (NSMenu.didBeginTrackingNotification, true), (NSMenu.didEndTrackingNotification, false),
      ] {
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
          self.menuOpen = open
          self.report()
        }
      }
    }
    Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in self.report() }
    // A line on stdin is answered once the main queue has handled every event before it.
    FileHandle.standardInput.readabilityHandler = { handle in
      if handle.availableData.isEmpty { exit(0) }
      DispatchQueue.main.async {
        self.report()
        print("PONG")
        fflush(stdout)
      }
    }
    print("READY \(ProcessInfo.processInfo.processIdentifier)")
    fflush(stdout)
  }

  func report() {
    let state: [String: Any] =
      front
      ? ["key": window.isKeyWindow, "active": NSApp.isActive, "typed": field.stringValue]
      : ["menu": menuOpen, "choice": popUp.titleOfSelectedItem ?? ""]
    let line = String(
      data: try! JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]),
      encoding: .utf8)!
    if line != last {
      last = line
      print("STATE \(line)")
      fflush(stdout)
    }
  }
}

let delegate = Delegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.regular)
NSApplication.shared.run()
