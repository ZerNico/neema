import AppKit

// Keeps the person's typing in their own app while neema opens a menu in the app behind it.
// An app that is not active opens a menu (a pop-up, a context menu) by stealing key focus from
// whichever app holds it: the person's window resigns key and their keys go to the menu, though
// nothing was activated or raised. The guard taps the person's app, swallows that notice and
// hands the theft back once the menu is on screen; the menu stays usable through accessibility.
// Ported from cua-driver's key_focus_guard (MIT, github.com/trycua/cua).
enum KeyFocus {
  private typealias Steal = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<Int32>) -> Int32
  private typealias Release = @convention(c) (Int32) -> Int32
  private typealias MainConnection = @convention(c) () -> UInt32
  private typealias GetProcess = @convention(c) (UnsafeMutableRawPointer) -> Int32
  private typealias GetKeyFocusProcess =
    @convention(c) (
      UnsafeMutableRawPointer, UnsafeMutableRawPointer
    ) -> Int32
  private typealias ProcessPID =
    @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<pid_t>) ->
    Int32
  private typealias GetField = @convention(c) (CGEvent, UInt32) -> Int64

  private static let loaded: Bool = {
    dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL)
      != nil
  }()
  private static func symbol<T>(_ name: String, as type: T.Type) -> T? {
    guard loaded, let pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else {
      return nil
    }
    return unsafeBitCast(pointer, to: type)
  }
  private static let steal = symbol("SLPSStealKeyFocusReturningID", as: Steal.self)
  private static let release = symbol("SLPSReleaseKeyFocusWithID", as: Release.self)
  private static let mainConnection = symbol("CGSMainConnectionID", as: MainConnection.self)
  private static let frontProcess = symbol("_SLPSGetFrontProcess", as: GetProcess.self)
  private static let keyFocusProcess = symbol(
    "SLPSGetKeyFocusProcess", as: GetKeyFocusProcess.self)
  private static let processPID = symbol("GetProcessPID", as: ProcessPID.self)
  private static let getField = symbol("CGEventGetIntegerValueField", as: GetField.self)

  /// The window server's notice to an app about its key focus, and its fields.
  private static let noticeType: UInt32 = 21
  private static let subtypeField: UInt32 = 64
  private static let thiefField: UInt32 = 73
  private static let lostKeyFocus: Int64 = 0x4000
  /// AppKit opens a pressed pop-up's menu from a delayed perform just after the call returns.
  private static let tail: TimeInterval = 3
  /// While the guard looks up a theft's id, its own theft's notice is hidden from the target,
  /// whose menu would close on it.
  private static let lookup: TimeInterval = 0.5
  /// How long to wait for the menu's window before releasing the theft. Released earlier, AppKit
  /// orders the menu's window group to the front, which raises the target's window.
  private static let menuWait: TimeInterval = 0.15
  /// Older ids tried after the newest, when another app stole in between.
  private static let slack: Int32 = 3
  private static let popUpMenuLayer = 101
  private static let own = getpid()

  private final class Tap {
    let pid: pid_t
    let port: CFMachPort
    var loop: CFRunLoop?
    init(pid: pid_t, port: CFMachPort) {
      self.pid = pid
      self.port = port
    }
  }

  /// Everything the taps' callbacks read, which run on their own threads.
  private static let lock = NSLock()
  nonisolated(unsafe) private static var front: Tap?
  nonisolated(unsafe) private static var targets: [pid_t: Tap] = [:]
  /// Guarded pid: actions under way, and when the tail after the last one ends.
  nonisolated(unsafe) private static var guarded: [pid_t: (actions: Int, until: Date)] = [:]
  nonisolated(unsafe) private static var lookupUntil = Date.distantPast

  private static func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  /// Guards the person's key focus while neema acts on `target`; call `end` when done. Nil, and
  /// the action runs as before, when the target is the person's app, nothing else holds key
  /// focus, or the private calls are gone. Arming never moves key focus: a key the person typed
  /// in that instant would be lost.
  static func protect(_ target: pid_t) -> Lease? {
    guard steal != nil, release != nil, mainConnection != nil, getField != nil,
      let person = frontPid(), person != target, person != own,
      // A launcher-style panel holding key focus would see the lookup's own theft.
      keyFocusPid() ?? person == person
    else { return nil }
    locked {
      let current = guarded[target]
      guarded[target] = ((current?.actions ?? 0) + 1, Date().addingTimeInterval(tail))
    }
    guard ensureFrontTap(person) else {
      Lease(target: target).end()
      return nil
    }
    _ = ensureTargetTap(target)
    return Lease(target: target)
  }

  struct Lease {
    let target: pid_t
    func end() {
      KeyFocus.locked {
        if let current = KeyFocus.guarded[target] {
          KeyFocus.guarded[target] = (max(0, current.actions - 1), Date().addingTimeInterval(tail))
        }
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + tail + 1) { KeyFocus.tidy() }
    }
  }

  private static func isGuarded(_ pid: pid_t) -> Bool {
    locked { guarded[pid].map { $0.actions > 0 || Date() < $0.until } ?? false }
  }

  /// The person's app: the window server's front process, which `NSWorkspace` learns late.
  private static func frontPid() -> pid_t? {
    guard let frontProcess, let processPID else {
      return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }
    var psn: (UInt32, UInt32) = (0, 0)
    guard withUnsafeMutableBytes(of: &psn, { frontProcess($0.baseAddress!) }) == 0 else {
      return nil
    }
    var pid: pid_t = 0
    let found = withUnsafeBytes(of: &psn) { processPID($0.baseAddress!, &pid) }
    return found == 0 && pid > 0 ? pid : nil
  }

  private static func keyFocusPid() -> pid_t? {
    guard let keyFocusProcess, let processPID else { return nil }
    var psn: (UInt32, UInt32) = (0, 0)
    var connection: (UInt64, UInt64) = (0, 0)
    let status = withUnsafeMutableBytes(of: &psn) { psnBytes in
      withUnsafeMutableBytes(of: &connection) {
        keyFocusProcess(psnBytes.baseAddress!, $0.baseAddress!)
      }
    }
    guard status == 0, psn != (0, 0) else { return nil }
    var pid: pid_t = 0
    let found = withUnsafeBytes(of: &psn) { processPID($0.baseAddress!, &pid) }
    return found == 0 && pid > 0 ? pid : nil
  }

  // MARK: Taps

  private static func notice(_ type: CGEventType, _ event: CGEvent) -> (thief: pid_t, lost: Bool)? {
    guard type.rawValue == noticeType, let getField,
      let thief = pid_t(exactly: getField(event, thiefField))
    else { return nil }
    return (thief, getField(event, subtypeField) == lostKeyFocus)
  }

  private static let frontCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      KeyFocus.locked { KeyFocus.front }.map { CGEvent.tapEnable(tap: $0.port, enable: true) }
      return Unmanaged.passUnretained(event)
    }
    guard let notice = KeyFocus.notice(type, event), notice.lost else {
      return Unmanaged.passUnretained(event)
    }
    // The guard's own lookup: the person's app never hears of it.
    if notice.thief == KeyFocus.own { return nil }
    guard KeyFocus.isGuarded(notice.thief) else { return Unmanaged.passUnretained(event) }
    // Swallowed now, so the person's window never resigns key; released once the menu shows.
    let thief = notice.thief
    DispatchQueue.global(qos: .userInteractive).async { KeyFocus.handBack(from: thief) }
    return nil
  }

  private static let targetCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      for tap in KeyFocus.locked({ Array(KeyFocus.targets.values) }) {
        CGEvent.tapEnable(tap: tap.port, enable: true)
      }
      return Unmanaged.passUnretained(event)
    }
    // AppKit ends menu tracking when its app hears it lost key focus: hide the lookup's theft.
    if let notice = KeyFocus.notice(type, event), notice.lost, notice.thief == KeyFocus.own,
      Date() < KeyFocus.locked({ KeyFocus.lookupUntil })
    {
      return nil
    }
    return Unmanaged.passUnretained(event)
  }

  private static func ensureFrontTap(_ pid: pid_t) -> Bool {
    if locked({ front?.pid == pid }) { return true }
    guard let tap = makeTap(pid, frontCallback) else { return false }
    let old = locked { () -> Tap? in
      let old = front
      front = tap
      return old
    }
    old.map(stop)
    return true
  }

  private static func ensureTargetTap(_ pid: pid_t) -> Bool {
    if locked({ targets[pid] != nil }) { return true }
    guard let tap = makeTap(pid, targetCallback) else { return false }
    locked { targets[pid] = tap }
    return true
  }

  /// A tap on one process's focus notices, on a thread of its own.
  private static func makeTap(_ pid: pid_t, _ callback: CGEventTapCallBack) -> Tap? {
    guard
      let port = CGEvent.tapCreateForPid(
        pid: pid, place: .headInsertEventTap, options: .defaultTap,
        eventsOfInterest: CGEventMask(1) << noticeType, callback: callback, userInfo: nil)
    else { return nil }
    let tap = Tap(pid: pid, port: port)
    let ready = DispatchSemaphore(value: 0)
    Thread {
      let source = CFMachPortCreateRunLoopSource(nil, port, 0)
      tap.loop = CFRunLoopGetCurrent()
      CFRunLoopAddSource(tap.loop, source, .commonModes)
      CGEvent.tapEnable(tap: port, enable: true)
      ready.signal()
      CFRunLoopRun()
      CFMachPortInvalidate(port)
    }.start()
    ready.wait()
    return tap
  }

  private static func stop(_ tap: Tap) {
    CGEvent.tapEnable(tap: tap.port, enable: false)
    tap.loop.map(CFRunLoopStop)
  }

  /// Drops the taps once nothing has been guarded for a while, so none sits on the person's app
  /// between tasks.
  private static func tidy() {
    let idle = locked { () -> [Tap] in
      let now = Date()
      guarded = guarded.filter { $0.value.actions > 0 || now < $0.value.until }
      var idle = targets.filter { guarded[$0.key] == nil }.map(\.value)
      targets = targets.filter { guarded[$0.key] != nil }
      if guarded.isEmpty, let tap = front {
        idle.append(tap)
        front = nil
      }
      return idle
    }
    idle.forEach(stop)
  }

  // MARK: Handing the theft back

  private static func handBack(from thief: pid_t) {
    let deadline = Date().addingTimeInterval(menuWait)
    while Date() < deadline, !hasMenuWindow(thief) { usleep(1000) }
    if let person = locked({ front?.pid }) { restoreOrder(above: thief, for: person) }
    // Theft ids come from one counter: a theft of our own takes the next one, and the target's
    // is the newest live one below it. Its notice to the target is hidden by the target's tap.
    locked { lookupUntil = Date().addingTimeInterval(lookup) }
    guard let steal, let release, let mainConnection else { return }
    var mine: Int32 = 0
    guard steal(mainConnection(), 0xC80, &mine) == 0, mine != 0 else { return }
    _ = release(mine)
    for back in 1...(slack + 1) {
      let id = mine &- back
      if id != 0, release(id) == 0 { return }
    }
  }

  private static func windows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
  }

  private static func hasMenuWindow(_ pid: pid_t) -> Bool {
    windows().contains {
      $0[kCGWindowOwnerPID as String] as? pid_t == pid
        && ($0[kCGWindowLayer as String] as? Int ?? 0) >= popUpMenuLayer
    }
  }

  /// Opening a menu orders its window group to the front, lifting the target's window over the
  /// person's. Their app raises its own focused window back, which activates nothing.
  private static func restoreOrder(above target: pid_t, for person: pid_t) {
    // Front to back: the first normal window of either app is the one on top.
    let top = windows().first {
      let owner = $0[kCGWindowOwnerPID as String] as? pid_t
      return ($0[kCGWindowLayer as String] as? Int) == 0 && (owner == target || owner == person)
    }
    guard top?[kCGWindowOwnerPID as String] as? pid_t == target else { return }
    let app = AXUIElementCreateApplication(person)
    var window: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &window)
        == .success,
      let window
    else { return }
    AXUIElementPerformAction(window as! AXUIElement, kAXRaiseAction as CFString)
  }
}
