import ApplicationServices
import Foundation

// A window's accessibility tree as the protocol's flat preorder node list. What is worth
// showing the model is decided by the desktop app (outline.ts), so this sends everything it
// walks. Node ids name elements until the next snapshot.
final class Snapshot {
  private(set) var elements: [String: AXUIElement] = [:]
  /// Nodes inside a web area. Chromium's page ignores an accessibility press there, while the
  /// app's native controls around it (a sheet's buttons) take one.
  private(set) var webNodes = Set<String>()
  private(set) var pid: pid_t = 0

  private static let maxNodes = 4000
  private static let maxDepth = 60

  func take(window: AXUIElement, pid: pid_t) -> (nodes: [[String: Any]], truncated: Bool) {
    elements = [:]
    webNodes = []
    self.pid = pid
    let bounds = frame(window)
    let origin = bounds?.origin ?? .zero
    var nodes: [[String: Any]] = []
    var truncated = false

    // An element met again is not walked again: some apps' trees contain cycles.
    var seen: [CFHashCode: [AXUIElement]] = [:]
    func walk(_ element: AXUIElement, depth: Int, inWeb: Bool) {
      if nodes.count >= Self.maxNodes || depth > Self.maxDepth {
        truncated = true
        return
      }
      let hash = CFHash(element)
      if seen[hash, default: []].contains(where: { CFEqual($0, element) }) { return }
      seen[hash, default: []].append(element)
      // Scrolled out of the window, with all it holds: a Downloads list of 386 rows took 12 s
      // to walk where 20 were shown. Elements without a size are often wrappers of visible ones.
      let box = frame(element)
      if depth > 0, let box, let bounds, box.width > 0, box.height > 0, !box.intersects(bounds) {
        return
      }
      let id = "n\(nodes.count + 1)"
      elements[id] = element
      let axRole: String = attribute(element, kAXRoleAttribute) ?? ""
      let subrole: String? = attribute(element, kAXSubroleAttribute)
      var node: [String: Any] = [
        "id": id,
        "depth": depth,
        "role": role(axRole, subrole: subrole),
        "actions": actions(element),
      ]
      if let name = label(element) { node["name"] = name }
      if let value = valueText(element) { node["value"] = value }
      if let box {
        node["frame"] = [
          "x": box.minX - origin.x, "y": box.minY - origin.y,
          "width": box.width, "height": box.height,
        ]
      }
      if attribute(element, kAXEnabledAttribute, as: Bool.self) == false { node["disabled"] = true }
      if attribute(element, kAXFocusedAttribute, as: Bool.self) == true { node["focused"] = true }
      nodes.append(node)
      // Visible children keep long lists short, but Chromium answers them with an empty list
      // where the page is, so an empty answer falls through to all children.
      let visible: [AXUIElement] = attribute(element, kAXVisibleChildrenAttribute) ?? []
      let children = visible.isEmpty ? attribute(element, kAXChildrenAttribute) ?? [] : visible
      if inWeb { webNodes.insert(id) }
      let below = inWeb || axRole == "AXWebArea"
      for child in children { walk(child, depth: depth + 1, inWeb: below) }
    }

    walk(window, depth: 0, inWeb: false)
    return (nodes, truncated)
  }

  private func label(_ element: AXUIElement) -> String? {
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
      if let text: String = attribute(element, key), !text.isEmpty { return text }
    }
    if let titled: AXUIElement = attribute(element, kAXTitleUIElementAttribute),
      let text: String = attribute(titled, kAXValueAttribute), !text.isEmpty
    {
      return text
    }
    return nil
  }

  private func valueText(_ element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
      let value
    else { return nil }
    if let text = value as? String { return text.isEmpty ? nil : text }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
  }

  private func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    AXUIElementCopyActionNames(element, &names)
    var result = ((names as? [String]) ?? []).compactMap { Self.actionNames[$0] }
    var settable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
      settable.boolValue
    {
      result.append("setValue")
    }
    return result
  }

  private static let actionNames: [String: String] = [
    "AXPress": "press",
    "AXShowMenu": "showMenu",
    "AXIncrement": "increment",
    "AXDecrement": "decrement",
  ]

  private func role(_ role: String, subrole: String?) -> String {
    switch subrole {
    case "AXCloseButton": return "closeButton"
    case "AXMinimizeButton": return "minimizeButton"
    case "AXZoomButton", "AXFullScreenButton": return "zoomButton"
    case "AXSwitch": return "switch"
    case "AXTabButton": return "tab"
    case "AXSearchField": return "searchField"
    case "AXDialog", "AXSystemDialog": return "dialog"
    default: break
    }
    return Self.roles[role] ?? "other"
  }

  private static let roles: [String: String] = [
    "AXWindow": "window",
    "AXSheet": "sheet",
    "AXToolbar": "toolbar",
    "AXMenuBar": "menuBar",
    "AXMenu": "menu",
    "AXMenuBarItem": "menuItem",
    "AXMenuItem": "menuItem",
    "AXButton": "button",
    "AXMenuButton": "popUpButton",
    "AXCheckBox": "checkbox",
    "AXRadioButton": "radio",
    "AXPopUpButton": "popUpButton",
    "AXComboBox": "comboBox",
    "AXTextField": "textField",
    "AXTextArea": "textArea",
    "AXSlider": "slider",
    "AXLink": "link",
    "AXTabGroup": "tabGroup",
    "AXTable": "table",
    "AXRow": "row",
    "AXColumn": "column",
    "AXCell": "cell",
    "AXList": "list",
    "AXOutline": "outline",
    "AXScrollArea": "scrollArea",
    "AXGroup": "group",
    "AXSplitGroup": "group",
    "AXRadioGroup": "group",
    "AXImage": "image",
    "AXStaticText": "text",
    "AXHeading": "heading",
    "AXWebArea": "webArea",
  ]
}
