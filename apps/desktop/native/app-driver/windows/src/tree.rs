//! A window's UI Automation tree as the protocol's flat preorder node list. What is worth showing
//! the model is decided by the desktop app (outline.ts), so this sends everything it walks. Node
//! ids name elements until the next snapshot.

use crate::error::{Res, fail};
use serde_json::{Value, json};
use std::time::Duration;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;
use windows::core::BSTR;

const MAX_NODES: usize = 4000;
const MAX_DEPTH: usize = 60;
/// Longer values (a whole document) are cut: the outline shows only a little of any value.
const MAX_VALUE: usize = 4000;

const PROPERTIES: &[UIA_PROPERTY_ID] = &[
    UIA_ControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_HelpTextPropertyId,
    UIA_AutomationIdPropertyId,
    UIA_FrameworkIdPropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_IsEnabledPropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsDialogPropertyId,
    UIA_ValueValuePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    UIA_RangeValueValuePropertyId,
    UIA_RangeValueIsReadOnlyPropertyId,
    UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_IsValuePatternAvailablePropertyId,
    UIA_IsRangeValuePatternAvailablePropertyId,
];

/// The elements of the latest look, by node id, and the processes they may belong to: a Store
/// app's frame is ApplicationFrameHost's, its content the app's.
#[derive(Default)]
pub struct Snapshot {
    elements: Vec<IUIAutomationElement>,
    pids: Vec<u32>,
}

pub struct Walked {
    pub nodes: Vec<Value>,
    pub truncated: bool,
    /// Chromium's page was not in the tree yet.
    pub web_missing: bool,
}

impl Snapshot {
    pub fn take(
        &mut self,
        uia: &IUIAutomation,
        hwnd: HWND,
        bounds: RECT,
        pids: Vec<u32>,
    ) -> Res<Walked> {
        self.elements.clear();
        self.pids = pids;
        unsafe {
            // One request reads every property of the whole tree in a single round trip: read one
            // by one, Chromium's tree took seconds (Cua measured over 4 s for 5,000 nodes).
            let request = uia.CreateCacheRequest()?;
            for &property in PROPERTIES {
                request.AddProperty(property)?;
            }
            request.SetTreeScope(TreeScope_Subtree)?;
            request.SetTreeFilter(&uia.ControlViewCondition()?)?;
            let root = uia.ElementFromHandle(hwnd)?;
            // Providers fail now and then while they rebuild; a moment later they answer.
            let mut cached = root.BuildUpdatedCache(&request);
            for _ in 0..2 {
                if cached.is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(40));
                cached = root.BuildUpdatedCache(&request);
            }
            let cached = cached?;
            let mut walked = Walked {
                nodes: Vec::new(),
                truncated: false,
                web_missing: false,
            };
            let chromium = crate::apps::class_name(hwnd).starts_with("Chrome_WidgetWin");
            let mut web = false;
            self.walk(&cached, 0, bounds, &mut walked, &mut web);
            walked.web_missing = chromium && !web;
            Ok(walked)
        }
    }

    unsafe fn walk(
        &mut self,
        element: &IUIAutomationElement,
        depth: usize,
        bounds: RECT,
        walked: &mut Walked,
        web: &mut bool,
    ) {
        if walked.nodes.len() >= MAX_NODES || depth > MAX_DEPTH {
            walked.truncated = true;
            return;
        }
        unsafe {
            let rect = element.CachedBoundingRectangle().unwrap_or_default();
            let sized = rect.right > rect.left && rect.bottom > rect.top;
            // Scrolled out of the window, with all it holds. Elements without a size are often
            // wrappers of visible ones.
            if depth > 0 && sized && !intersects(rect, bounds) {
                return;
            }
            let children = element.GetCachedChildren().ok();
            let count = children.as_ref().and_then(|c| c.Length().ok()).unwrap_or(0);
            let control = element.CachedControlType().map(|c| c.0).unwrap_or(0);
            let framework = text(element.CachedFrameworkId());
            let role = role(element, control, depth, count, framework.as_deref());
            if role == "webArea" {
                *web = true;
            }
            let id = format!("n{}", walked.nodes.len() + 1);
            let mut node = json!({
                "id": id,
                "depth": depth,
                "role": role,
                "actions": actions(element),
            });
            let name = text(element.CachedName()).or_else(|| text(element.CachedHelpText()));
            if let Some(name) = name {
                node["name"] = json!(name);
            }
            if let Some(value) = value(element) {
                node["value"] = json!(value);
            }
            if sized {
                node["frame"] = json!({
                    "x": rect.left - bounds.left,
                    "y": rect.top - bounds.top,
                    "width": rect.right - rect.left,
                    "height": rect.bottom - rect.top,
                });
            }
            if element
                .CachedIsEnabled()
                .is_ok_and(|enabled| !enabled.as_bool())
            {
                node["disabled"] = json!(true);
            }
            if element
                .CachedHasKeyboardFocus()
                .is_ok_and(|focused| focused.as_bool())
            {
                node["focused"] = json!(true);
            }
            walked.nodes.push(node);
            self.elements.push(element.clone());
            if let Some(children) = children {
                for index in 0..count {
                    if let Ok(child) = children.GetElement(index) {
                        self.walk(&child, depth + 1, bounds, walked, web);
                    }
                }
            }
        }
    }

    /// The element a node id of the latest look names, if it still belongs to the app.
    pub fn element(&self, id: &str) -> Res<IUIAutomationElement> {
        let index = id
            .strip_prefix('n')
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(0);
        let Some(element) = index.checked_sub(1).and_then(|i| self.elements.get(i)) else {
            return fail("stale_node", format!("{id} is not in the latest look"));
        };
        let pid = unsafe { element.CurrentProcessId() }.unwrap_or(0) as u32;
        if !self.pids.contains(&pid) {
            return fail("off_limits", format!("{id} left the app"));
        }
        Ok(element.clone())
    }
}

fn intersects(a: RECT, b: RECT) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

fn text(value: windows::core::Result<BSTR>) -> Option<String> {
    let text = value.ok()?.to_string();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn flag(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> bool {
    unsafe { element.GetCachedPropertyValue(property) }
        .ok()
        .and_then(|value| bool::try_from(&value).ok())
        .unwrap_or(false)
}

fn value(element: &IUIAutomationElement) -> Option<String> {
    let read =
        |property| -> Option<VARIANT> { unsafe { element.GetCachedPropertyValue(property) }.ok() };
    if flag(element, UIA_IsValuePatternAvailablePropertyId)
        && let Some(text) = read(UIA_ValueValuePropertyId)
            .and_then(|value| BSTR::try_from(&value).ok())
            .map(|value| value.to_string())
            .filter(|value| !value.is_empty())
    {
        return Some(text.chars().take(MAX_VALUE).collect());
    }
    if flag(element, UIA_IsRangeValuePatternAvailablePropertyId)
        && let Some(number) =
            read(UIA_RangeValueValuePropertyId).and_then(|value| f64::try_from(&value).ok())
    {
        return Some(number.to_string());
    }
    None
}

fn actions(element: &IUIAutomationElement) -> Vec<&'static str> {
    let mut actions = Vec::new();
    if flag(element, UIA_IsInvokePatternAvailablePropertyId)
        || flag(element, UIA_IsTogglePatternAvailablePropertyId)
        || flag(element, UIA_IsSelectionItemPatternAvailablePropertyId)
        || flag(element, UIA_IsExpandCollapsePatternAvailablePropertyId)
    {
        actions.push("press");
    }
    if flag(element, UIA_IsRangeValuePatternAvailablePropertyId)
        && !flag(element, UIA_RangeValueIsReadOnlyPropertyId)
    {
        actions.extend(["increment", "decrement"]);
    }
    if flag(element, UIA_IsValuePatternAvailablePropertyId)
        && !flag(element, UIA_ValueIsReadOnlyPropertyId)
    {
        actions.push("setValue");
    }
    actions
}

/// UI Automation's control types onto the protocol's roles, as the macOS driver maps AX roles.
fn role(
    element: &IUIAutomationElement,
    control: i32,
    depth: usize,
    children: i32,
    framework: Option<&str>,
) -> &'static str {
    let automation_id = text(unsafe { element.CachedAutomationId() }).unwrap_or_default();
    match control {
        50000 => match automation_id.as_str() {
            "Close" => "closeButton",
            "Minimize" => "minimizeButton",
            "Maximize" | "Maximize-Restore" | "Restore" => "zoomButton",
            _ => "button",
        },
        50002 => "checkbox",
        50003 => "comboBox",
        50004 => "textField",
        50005 => "link",
        50006 => "image",
        50007 => "listItem",
        50008 => "list",
        50009 => "menu",
        50010 => "menuBar",
        50011 => "menuItem",
        50013 => "radio",
        50015 => "slider",
        50018 => "tabGroup",
        50019 => "tab",
        50020 => "text",
        50021 | 50040 => "toolbar",
        50023 => "outline",
        50024 => "treeItem",
        50001 | 50017 | 50026 | 50033 | 50039 => "group",
        50028 | 50036 => "table",
        // A grid's item is a row of cells, or a cell itself, as a spreadsheet's are.
        50029 => {
            if children > 0 {
                "row"
            } else {
                "cell"
            }
        }
        50030 => {
            if framework == Some("Chrome") {
                "webArea"
            } else {
                "textArea"
            }
        }
        50031 => "popUpButton",
        50032 if flag(element, UIA_IsDialogPropertyId) => "dialog",
        // A window inside the window is a part of it, as a Store app's content is.
        50032 => {
            if depth == 0 {
                "window"
            } else {
                "group"
            }
        }
        50034 => "row",
        50035 => "column",
        _ => "other",
    }
}

/// A plain press without the pointer: whichever pattern the element offers. False when it offers
/// none, and the pointer has to click. A pattern that fails is not tried with the pointer: an
/// Invoke whose handler outlasts the timeout reports failure after it pressed, and a click would
/// press a second time.
pub fn press(element: &IUIAutomationElement) -> Res<bool> {
    let pressed = |result: windows::core::Result<()>| match result {
        Ok(()) => Ok(true),
        Err(_) => fail(
            "action_failed",
            "The app did not answer the press; look before trying again",
        ),
    };
    unsafe {
        if let Ok(pattern) =
            element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
        {
            return pressed(pattern.Invoke());
        }
        if let Ok(pattern) =
            element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        {
            return pressed(pattern.Toggle());
        }
        if let Ok(pattern) = element
            .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
        {
            return pressed(pattern.Select());
        }
        if let Ok(pattern) = element
            .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
        {
            let collapsed = pattern
                .CurrentExpandCollapseState()
                .is_ok_and(|state| state == ExpandCollapseState_Collapsed);
            return pressed(if collapsed {
                pattern.Expand()
            } else {
                pattern.Collapse()
            });
        }
        Ok(false)
    }
}

pub fn set_value(element: &IUIAutomationElement, value: &str) -> Res<()> {
    unsafe {
        let Ok(pattern) =
            element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        else {
            return fail("action_failed", "That element has no value to set");
        };
        if pattern.SetValue(&BSTR::from(value)).is_err() {
            return fail("action_failed", "That value cannot be set");
        }
        Ok(())
    }
}

/// The element's centre on the screen, where it is now.
pub fn centre(element: &IUIAutomationElement) -> Res<(i32, i32)> {
    let rect = unsafe { element.CurrentBoundingRectangle() }.unwrap_or_default();
    if rect.right <= rect.left || rect.bottom <= rect.top {
        return fail("no_frame", "That element has no position");
    }
    Ok(((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2))
}

pub fn focus(element: &IUIAutomationElement) {
    unsafe {
        let _ = element.SetFocus();
    }
}
