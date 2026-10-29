//! Real input with the app in front. Windows delivers posted clicks to few apps (Chromium and WPF
//! ignore them), so pointer and keys go through SendInput, after the window takes the foreground
//! and the point is confirmed to be the app's.

use crate::error::{Res, fail};
use crate::keys;
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, POINT};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY, TokenIntegrityLevel,
};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GA_ROOT, GetAncestor, GetCursorPos, GetForegroundWindow,
    GetWindowThreadProcessId, IsIconic, SW_RESTORE, SetCursorPos, SetForegroundWindow, ShowWindow,
    WHEEL_DELTA, WindowFromPoint,
};

/// Stamped on all the driver's input, so the person's is told from it: Windows marks input
/// injected, but remote-control tools and the touch keyboard inject the person's too.
pub const OURS: usize = 0x6E65_656D;

/// The window being driven, and the app's own process, whose other windows (the menus and popups
/// an app opens as windows of their own) count as the app's too.
pub struct Target {
    pub hwnd: HWND,
    pub app: Option<u32>,
}

impl Target {
    /// Judged by the content's process, never ApplicationFrameHost's, which every Store app's
    /// frame belongs to: by that, Settings would pass for Calculator.
    pub fn owns(&self, hwnd: HWND) -> bool {
        if hwnd.is_invalid() {
            return false;
        }
        let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
        root == self.hwnd
            || self
                .app
                .is_some_and(|pid| crate::apps::content_pid(root) == pid)
    }

    pub fn in_front(&self) -> bool {
        self.owns(unsafe { GetForegroundWindow() })
    }
}

fn send(inputs: &[INPUT]) -> Res<()> {
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return fail(
            "action_failed",
            "Windows refused the input: the app may run as administrator, or a system prompt is open",
        );
    }
    Ok(())
}

fn key(code: u16, up: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(code as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut flags = if up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    if keys::extended(code) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(code),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: OURS,
            },
        },
    }
}

fn unicode(unit: u16, up: bool) -> INPUT {
    let flags = if up {
        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
    } else {
        KEYEVENTF_UNICODE
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: OURS,
            },
        },
    }
}

/// A button or wheel event where the pointer is.
fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: OURS,
            },
        },
    }
}

/// Puts the pointer on a screen pixel. Not with SendInput's absolute coordinates: Windows maps
/// those with the scaling of the display the pointer is on, so from a display of another scaling
/// the first click landed elsewhere (measured). SetCursorPos takes the driver's physical pixels.
fn point_to((x, y): (i32, i32)) -> Res<()> {
    let mut now = POINT::default();
    unsafe {
        let _ = SetCursorPos(x, y);
        let _ = GetCursorPos(&mut now);
    }
    if (now.x, now.y) != (x, y) {
        return fail("action_failed", "The pointer could not be put there");
    }
    Ok(())
}

/// Brings the window to the front, as input on Windows needs.
pub fn foreground(target: &Target) -> Res<()> {
    unsafe {
        if IsIconic(target.hwnd).as_bool() {
            let _ = ShowWindow(target.hwnd, SW_RESTORE);
        }
    }
    if target.in_front() {
        return Ok(());
    }
    if !bring(target.hwnd, || target.in_front())? {
        return fail("action_failed", "The window would not come to the front");
    }
    // Focus moves into the window after it activates, into a Store app's content window later
    // still: a key sent at once was lost (measured on Calculator).
    std::thread::sleep(Duration::from_millis(150));
    Ok(())
}

/// Windows lets a process take the foreground only while it holds the last input, so a key
/// nothing maps (VK_NONAME, after Cua) gives the driver that before trying again.
fn bring(hwnd: HWND, arrived: impl Fn() -> bool) -> Res<bool> {
    for _ in 0..4 {
        unsafe {
            let current = GetForegroundWindow();
            let theirs = GetWindowThreadProcessId(current, None);
            let mine = GetCurrentThreadId();
            let attached =
                theirs != 0 && theirs != mine && AttachThreadInput(mine, theirs, true).as_bool();
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            if attached {
                let _ = AttachThreadInput(mine, theirs, false);
            }
        }
        if arrived() {
            return Ok(true);
        }
        send(&[key(0xFC, false), key(0xFC, true)])?;
        std::thread::sleep(Duration::from_millis(25));
    }
    Ok(false)
}

/// XAML and Chromium bring themselves forward from inside a press's handler, so the person's
/// window is given back. Theirs is disabled meanwhile, so it never rises. Win32 windows are not:
/// a modal dialog the press opens disables its owner, and enabling it after would undo that.
pub fn pressing<T>(target: &Target, press: impl FnOnce() -> T) -> T {
    let before = unsafe { GetForegroundWindow() };
    let class = crate::apps::class_name(target.hwnd);
    let raises = matches!(
        class.as_str(),
        "ApplicationFrameWindow" | "WinUIDesktopWin32WindowClass"
    ) || class.starts_with("Chrome_WidgetWin");
    // EnableWindow says false when the window was enabled, so only those this disabled come back.
    let disabled: Vec<HWND> = if raises {
        [Some(target.hwnd), crate::apps::core_window(target.hwnd)]
            .into_iter()
            .flatten()
            .filter(|&window| !unsafe { EnableWindow(window, false) }.as_bool())
            .collect()
    } else {
        Vec::new()
    };
    let result = press();
    if !before.is_invalid() && !target.owns(before) {
        // The handler may run after the press returns; it took the front within this in tests.
        for _ in 0..25 {
            if target.in_front() {
                let _ = bring(before, || unsafe { GetForegroundWindow() } == before);
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    for window in disabled {
        unsafe {
            let _ = EnableWindow(window, true);
        }
    }
    result
}

/// Refuses a point another window covers: the input would reach that app instead.
pub fn lands_on(target: &Target, (x, y): (i32, i32)) -> Res<()> {
    let under = unsafe { WindowFromPoint(POINT { x, y }) };
    if !target.owns(under) {
        return fail(
            "action_failed",
            "Another window covers that point, so nothing was done",
        );
    }
    Ok(())
}

/// The person's pointer goes back where it was once the input is in.
fn keeping_cursor<T>(work: impl FnOnce() -> Res<T>) -> Res<T> {
    let mut saved = POINT::default();
    let had = unsafe { GetCursorPos(&mut saved) }.is_ok();
    let result = work();
    if had {
        std::thread::sleep(Duration::from_millis(30));
        unsafe {
            let _ = SetCursorPos(saved.x, saved.y);
        }
    }
    result
}

pub fn click(at: (i32, i32), button: &str, count: u32, modifiers: &[u16]) -> Res<()> {
    let (down, up) = match button {
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    };
    keeping_cursor(|| {
        point_to(at)?;
        let mut inputs: Vec<INPUT> = modifiers.iter().map(|&m| key(m, false)).collect();
        for _ in 0..count {
            inputs.push(mouse(down, 0));
            inputs.push(mouse(up, 0));
        }
        inputs.extend(modifiers.iter().rev().map(|&m| key(m, true)));
        send(&inputs)
    })
}

/// By lines; positive y reveals what is above, positive x what is left, as a wheel does.
pub fn scroll(at: (i32, i32), x: i32, y: i32) -> Res<()> {
    keeping_cursor(|| {
        point_to(at)?;
        let mut inputs = Vec::new();
        if y != 0 {
            inputs.push(mouse(MOUSEEVENTF_WHEEL, y * WHEEL_DELTA as i32));
        }
        if x != 0 {
            inputs.push(mouse(MOUSEEVENTF_HWHEEL, -x * WHEEL_DELTA as i32));
        }
        send(&inputs)
    })
}

pub fn drag(from: (i32, i32), to: (i32, i32)) -> Res<()> {
    keeping_cursor(|| {
        point_to(from)?;
        send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)])?;
        // Apps start a drag only after the pointer moves with the button held, step by step.
        const STEPS: i32 = 12;
        for step in 1..=STEPS {
            let at = (
                from.0 + (to.0 - from.0) * step / STEPS,
                from.1 + (to.1 - from.1) * step / STEPS,
            );
            std::thread::sleep(Duration::from_millis(12));
            if let Err(error) = point_to(at) {
                // Never leave the button held.
                let _ = send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]);
                return Err(error);
            }
        }
        std::thread::sleep(Duration::from_millis(30));
        send(&[mouse(MOUSEEVENTF_LEFTUP, 0)])
    })
}

/// Typed as characters, not keys, so the layout cannot change them. Stops when another window
/// takes the front: the rest would go there.
pub fn type_text(target: &Target, text: &str) -> Res<()> {
    let text = text.replace("\r\n", "\n");
    let units: Vec<u16> = text.encode_utf16().collect();
    for chunk in units.chunks(32) {
        if !target.in_front() {
            return fail(
                "action_failed",
                "Another window came to the front, so typing stopped",
            );
        }
        let mut inputs = Vec::with_capacity(chunk.len() * 2);
        for &unit in chunk {
            // A newline typed as a character joined the lines in some apps; Return is a key.
            match unit {
                0x0A => inputs.extend([key(keys::RETURN, false), key(keys::RETURN, true)]),
                0x09 => inputs.extend([key(keys::TAB, false), key(keys::TAB, true)]),
                _ => inputs.extend([unicode(unit, false), unicode(unit, true)]),
            }
        }
        send(&inputs)?;
        std::thread::sleep(Duration::from_millis(8));
    }
    Ok(())
}

pub fn press(chord: &keys::Chord) -> Res<()> {
    let mut inputs: Vec<INPUT> = chord.modifiers.iter().map(|&m| key(m, false)).collect();
    inputs.extend([key(chord.key, false), key(chord.key, true)]);
    inputs.extend(chord.modifiers.iter().rev().map(|&m| key(m, true)));
    send(&inputs)
}

fn integrity(process: HANDLE) -> Option<u32> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut length = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut length);
        let mut buffer = vec![0u8; length as usize];
        let read = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buffer.as_mut_ptr() as *mut _),
            length,
            &mut length,
        );
        let _ = CloseHandle(token);
        read.ok()?;
        let label = &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        Some(*GetSidSubAuthority(label.Label.Sid, count as u32 - 1))
    }
}

/// An app running as administrator ignores input from below; Windows drops it without a word.
pub fn above_us(pid: u32) -> bool {
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let theirs = integrity(process);
        let _ = CloseHandle(process);
        matches!((theirs, integrity(GetCurrentProcess())), (Some(theirs), Some(ours)) if theirs > ours)
    }
}
