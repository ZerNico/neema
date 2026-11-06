import Carbon.HIToolbox
import CoreGraphics

struct Chord {
  let key: CGKeyCode
  let flags: CGEventFlags
}

private let modifiers: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand, "super": .maskCommand,
  "win": .maskCommand,
  "ctrl": .maskControl, "control": .maskControl,
  "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
  "shift": .maskShift,
  "fn": .maskSecondaryFn,
]

private let named: [String: Int] = [
  "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab, "space": kVK_Space,
  "backspace": kVK_Delete, "delete": kVK_ForwardDelete, "escape": kVK_Escape,
  "esc": kVK_Escape, "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp,
  "pagedown": kVK_PageDown, "left": kVK_LeftArrow, "right": kVK_RightArrow,
  "up": kVK_UpArrow, "down": kVK_DownArrow, "arrowleft": kVK_LeftArrow,
  "arrowright": kVK_RightArrow, "arrowup": kVK_UpArrow, "arrowdown": kVK_DownArrow,
  "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
  "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
]

/// Reads `cmd+shift+s`, `Return`, `ctrl+Tab`. Modifiers are not case sensitive; a single
/// character is found on the current keyboard layout.
func parseChord(_ text: String) throws -> Chord {
  let parts = text.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
  // "cmd++" means cmd and the plus key.
  let keyPart = text.hasSuffix("++") ? "+" : parts.last ?? ""
  let modifierParts = text.hasSuffix("++") ? parts.dropLast(2) : parts.dropLast()
  var flags: CGEventFlags = []
  for part in modifierParts {
    guard let flag = modifiers[part.lowercased()] else {
      throw DriverError(code: "invalid_params", message: "Unknown modifier \(part)")
    }
    flags.insert(flag)
  }
  if let code = named[keyPart.lowercased()] { return Chord(key: CGKeyCode(code), flags: flags) }
  guard keyPart.count == 1, let found = keyCode(for: Character(keyPart.lowercased())) else {
    throw DriverError(code: "invalid_params", message: "Unknown key \(keyPart)")
  }
  // A capital asks for shift, as "S" would be typed.
  if keyPart != keyPart.lowercased() { flags.insert(.maskShift) }
  return Chord(key: found, flags: flags)
}

/// The key that types `character` without modifiers on the current layout.
private func keyCode(for character: Character) -> CGKeyCode? {
  guard
    let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
    let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
  else { return nil }
  let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
  return data.withUnsafeBytes { raw -> CGKeyCode? in
    guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else {
      return nil
    }
    for code in 0..<CGKeyCode(128) {
      var dead: UInt32 = 0
      var length = 0
      var chars = [UniChar](repeating: 0, count: 4)
      let status = UCKeyTranslate(
        layout, code, UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
        OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars)
      if status == noErr, length == 1, String(utf16CodeUnits: chars, count: 1).lowercased() == String(character)
      {
        return code
      }
    }
    return nil
  }
}
