// A native app for real-driver.test.ts with a document window and a utility panel that holds
// the keys, as a Find panel or an inspector does. It prints its state as a JSON line whenever it
// changes, so the test proves where text arrived and which window has the keys afterwards.
import AppKit

final class Delegate: NSObject, NSApplicationDelegate {
  let document = NSWindow(
    contentRect: NSRect(x: 300, y: 300, width: 360, height: 160), styleMask: [.titled],
    backing: .buffered, defer: false)
  let panel = NSPanel(
    contentRect: NSRect(x: 700, y: 300, width: 300, height: 120),
    styleMask: [.titled, .utilityWindow], backing: .buffered, defer: false)
  let documentField = NSTextField(frame: NSRect(x: 20, y: 60, width: 320, height: 24))
  let panelField = NSTextField(frame: NSRect(x: 20, y: 40, width: 260, height: 24))
  var last = ""

  func applicationDidFinishLaunching(_ notification: Notification) {
    document.title = "Document"
    documentField.placeholderString = "Document field"
    document.contentView!.addSubview(documentField)
    panel.title = "Panel"
    panel.becomesKeyOnlyIfNeeded = false
    panelField.placeholderString = "Panel field"
    panel.contentView!.addSubview(panelField)
    document.orderFront(nil)
    document.makeMain()
    document.makeFirstResponder(documentField)
    panel.orderFront(nil)
    panel.makeKey()
    panel.makeFirstResponder(panelField)
    Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in self.report() }
    // Quits with whatever started it, as the Electron fixture does.
    FileHandle.standardInput.readabilityHandler = { handle in
      if handle.availableData.isEmpty { exit(0) }
    }
    print("READY \(ProcessInfo.processInfo.processIdentifier)")
    fflush(stdout)
  }

  func report() {
    let state: [String: String] = [
      "document": documentField.stringValue, "panel": panelField.stringValue,
      "key": NSApp.keyWindow?.title ?? "",
    ]
    let line = String(data: try! JSONSerialization.data(withJSONObject: state), encoding: .utf8)!
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
