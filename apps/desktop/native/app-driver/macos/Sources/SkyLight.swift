import CoreGraphics
import Foundation

// Private window server calls, for input that reaches a covered window without raising it or
// moving the person's cursor. Public CGEvent posting cannot: a click goes to whatever is under
// the real cursor. Codex's helper and Cua's driver do the same. The recipe follows cua-driver
// (MIT, github.com/trycua/cua), whose focus records come from yabai (MIT).
//
// Every symbol is looked up by name, so a macOS release that drops one degrades to the public
// route instead of failing to load.
enum SkyLight {
  private typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
  private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
  private typealias SetIntegerField = @convention(c) (CGEvent, UInt32, Int64) -> Void
  private typealias PostEventRecordTo = @convention(c) (UnsafeRawPointer, UnsafeRawPointer) -> Int32
  private typealias MainConnection = @convention(c) () -> UInt32
  private typealias WindowOwner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) ->
    Int32
  private typealias ConnectionPSN = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32
  private typealias ProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32

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

  private static let postToPid = symbol("SLEventPostToPid", as: PostToPid.self)
  private static let setWindowLocation = symbol(
    "CGEventSetWindowLocation", as: SetWindowLocation.self)
  private static let setIntegerField = symbol(
    "SLEventSetIntegerValueField", as: SetIntegerField.self)
  private static let postEventRecordTo = symbol(
    "SLPSPostEventRecordTo", as: PostEventRecordTo.self)
  private static let mainConnection = symbol("CGSMainConnectionID", as: MainConnection.self)
  private static let windowOwner = symbol("SLSGetWindowOwner", as: WindowOwner.self)
  private static let connectionPSN = symbol("SLSGetConnectionPSN", as: ConnectionPSN.self)
  private static let processForPID = symbol("GetProcessForPID", as: ProcessForPID.self)

  /// Whether a background click can be made at all.
  static var available: Bool {
    postToPid != nil && setIntegerField != nil && postEventRecordTo != nil
  }

  /// Makes the window take input without raising it. Only the target gets a record: defocusing
  /// the person's front app left their window deaf to typing until they clicked it (Cua #4024).
  static func focusWithoutRaise(pid: pid_t, window: CGWindowID) -> Bool {
    guard let postEventRecordTo, var psn = processSerialNumber(pid: pid, window: window) else {
      return false
    }
    var record = [UInt8](repeating: 0, count: 0xF8)
    record[0x04] = 0xF8
    record[0x08] = 0x0D
    withUnsafeBytes(of: window.littleEndian) { record.replaceSubrange(0x3C..<0x40, with: $0) }
    record[0x8A] = 0x01
    return withUnsafeBytes(of: &psn) { psnBytes in
      record.withUnsafeBytes { postEventRecordTo(psnBytes.baseAddress!, $0.baseAddress!) == 0 }
    }
  }

  /// Posts a mouse event to one process, stamped with the fields AppKit and Chromium route a
  /// background window's input by.
  static func postMouse(
    _ event: CGEvent, pid: pid_t, window: CGWindowID, local: CGPoint, clickState: Int64,
    button: Int64, group: Int64
  ) {
    setWindowLocation?(event, local)
    if let set = setIntegerField {
      set(event, 1, clickState)  // click state
      set(event, 3, button)  // button number
      set(event, 7, 3)  // subtype
      set(event, 51, Int64(window))  // window number
      set(event, 58, group)  // one gesture
      set(event, 91, Int64(window))  // window under the pointer
      set(event, 92, Int64(window))  // that window can handle it
      set(event, 40, Int64(pid))  // target pid, which Chromium filters synthetic events by
    }
    if let postToPid { postToPid(pid, event) } else { event.postToPid(pid) }
  }

  // An 8-byte ProcessSerialNumber, as two 32-bit halves.
  private static func processSerialNumber(pid: pid_t, window: CGWindowID) -> (UInt32, UInt32)? {
    var psn: (UInt32, UInt32) = (0, 0)
    if let mainConnection, let windowOwner, let connectionPSN {
      var owner: UInt32 = 0
      if windowOwner(mainConnection(), window, &owner) == 0, owner != 0,
        withUnsafeMutableBytes(of: &psn, { connectionPSN(owner, $0.baseAddress!) }) == 0
      {
        return psn
      }
    }
    if let processForPID,
      withUnsafeMutableBytes(of: &psn, { processForPID(pid, $0.baseAddress!) }) == 0
    {
      return psn
    }
    return nil
  }
}
