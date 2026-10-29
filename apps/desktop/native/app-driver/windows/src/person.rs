//! The person's own input wins. While they click, type or scroll in the app being used, its
//! actions wait for them. Windows keeps no per-kind record of hardware input, so low-level hooks
//! note when the person last pressed a key or a button and which window it went to. The driver
//! stamps its own input, which is not counted; Windows' injected flag would also drop the person's
//! input through remote-control tools and the touch keyboard. Only those times and windows are kept.
//!
//! The window is noted as the input happens, unlike macOS's check of where it would go now: here
//! the driver brings the app to the front, so keys the person typed into their own window a moment
//! before would otherwise count as using the app.

use crate::input::Target;
use std::sync::atomic::{AtomicIsize, AtomicU32, AtomicU64, Ordering};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::UI::WindowsAndMessaging::*;

/// How long the person must have left the app alone before an action goes ahead.
const QUIET_MS: u64 = 2500;

static KEY: AtomicU64 = AtomicU64::new(0);
static KEY_WINDOW: AtomicIsize = AtomicIsize::new(0);
static POINTER: AtomicU64 = AtomicU64::new(0);
static POINTER_WINDOW: AtomicIsize = AtomicIsize::new(0);
static HELD: AtomicU32 = AtomicU32::new(0);

/// The pointer's input goes to the window under it.
fn pointed(info: &MSLLHOOKSTRUCT) {
    POINTER.store(now(), Ordering::Relaxed);
    POINTER_WINDOW.store(
        unsafe { WindowFromPoint(info.pt) }.0 as isize,
        Ordering::Relaxed,
    );
}

fn now() -> u64 {
    unsafe { GetTickCount64() }
}

unsafe extern "system" fn keyboard(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    unsafe {
        if code >= 0 {
            let info = &*(data.0 as *const KBDLLHOOKSTRUCT);
            let down = matches!(message.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            if down && info.dwExtraInfo != crate::input::OURS {
                KEY.store(now(), Ordering::Relaxed);
                KEY_WINDOW.store(GetForegroundWindow().0 as isize, Ordering::Relaxed);
            }
        }
        CallNextHookEx(None, code, message, data)
    }
}

unsafe extern "system" fn pointer(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    unsafe {
        if code >= 0 {
            let info = &*(data.0 as *const MSLLHOOKSTRUCT);
            if info.dwExtraInfo != crate::input::OURS {
                match message.0 as u32 {
                    WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN => {
                        HELD.fetch_add(1, Ordering::Relaxed);
                        pointed(info);
                    }
                    WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP => {
                        let _ = HELD.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                            Some(n.saturating_sub(1))
                        });
                        pointed(info);
                    }
                    WM_MOUSEWHEEL | WM_MOUSEHWHEEL => pointed(info),
                    // Moving alone is not using an app; dragging is.
                    WM_MOUSEMOVE if HELD.load(Ordering::Relaxed) > 0 => pointed(info),
                    _ => {}
                }
            }
        }
        CallNextHookEx(None, code, message, data)
    }
}

/// Starts noting the person's input, on a thread of its own: Windows calls low-level hooks on the
/// thread that set them, which must keep reading messages, and drops a hook that answers late.
pub fn watch() {
    std::thread::spawn(|| unsafe {
        let module = GetModuleHandleW(None).ok();
        let instance = module.map(|m| windows::Win32::Foundation::HINSTANCE(m.0));
        let _keys = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), instance, 0);
        let _pointer = SetWindowsHookExW(WH_MOUSE_LL, Some(pointer), instance, 0);
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {}
    });
}

/// How long to wait for the person in the target's app, in seconds; zero when they are not using
/// it. Keys count when they went to the app, in front then; clicks and scrolls when its window
/// was under the pointer.
pub fn busy(target: &Target) -> f64 {
    let recent = |time: &AtomicU64, window: &AtomicIsize| {
        let since = now().saturating_sub(time.load(Ordering::Relaxed));
        let went = HWND(window.load(Ordering::Relaxed) as *mut _);
        if since < QUIET_MS && target.owns(went) {
            QUIET_MS - since
        } else {
            0
        }
    };
    recent(&KEY, &KEY_WINDOW).max(recent(&POINTER, &POINTER_WINDOW)) as f64 / 1000.0
}
