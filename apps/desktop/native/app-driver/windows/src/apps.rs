//! Running apps, their windows and identities, installed apps and launching. An app is named by
//! one id whether running or not, so a grant keeps meaning the same app: a packaged app by its
//! AppUserModelID, any other by its executable's path.

use crate::error::{Res, fail};
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HWND, LPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Storage::EnhancedStorage::{
    PKEY_AppUserModel_ID, PKEY_Link_Arguments, PKEY_Link_TargetParsingPath,
};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use windows::Win32::System::Com::{CLSCTX_LOCAL_SERVER, CoCreateInstance, CoTaskMemFree};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetUserObjectInformationW,
    OpenInputDesktop, UOI_NAME,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetProcessId, OpenProcess, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
use windows::Win32::UI::Shell::{
    AO_NONE, ApplicationActivationManager, BHID_EnumItems, FOLDERID_AppsFolder,
    IApplicationActivationManager, IEnumShellItems, IShellItem, IShellItem2, KF_FLAG_DEFAULT,
    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS, SHCreateItemFromParsingName, SHELLEXECUTEINFOW,
    SHGetKnownFolderItem, SHGetKnownFolderPath, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
    ShellExecuteExW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GW_ENABLEDPOPUP, GW_OWNER, GWL_EXSTYLE, GetClassNameW,
    GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, SW_SHOWNOACTIVATE, SW_SHOWNORMAL,
    ShowWindow, WS_EX_TOOLWINDOW,
};
use windows::core::{BOOL, GUID, Interface, PCWSTR, PWSTR, w};

pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// A top-level window a person would call an app's, and the process whose content it shows.
#[derive(Clone, Copy)]
pub struct Window {
    pub hwnd: HWND,
    pub pid: u32,
}

#[derive(Clone)]
pub struct App {
    pub app_id: String,
    pub name: String,
    pub exe: String,
    /// What starts it, when not its id: a Start entry, which keeps its shortcut's arguments.
    pub launch: Option<String>,
}

/// Apps app use never touches, whatever the person allows, by executable. Checked here rather
/// than only in the desktop app so a confused caller cannot reach them either.
const OFF_LIMITS_EXE: &[&str] = &[
    // Terminals: the model already has the chat's VM for commands.
    "cmd.exe",
    "powershell.exe",
    "powershell_ise.exe",
    "pwsh.exe",
    "windowsterminal.exe",
    "wt.exe",
    "openconsole.exe",
    "conhost.exe",
    "mintty.exe",
    "alacritty.exe",
    "wezterm-gui.exe",
    "hyper.exe",
    "tabby.exe",
    "warp.exe",
    "wsl.exe",
    "wslhost.exe",
    "bash.exe",
    // Credentials.
    "1password.exe",
    "bitwarden.exe",
    "keepass.exe",
    "keepassxc.exe",
    "enpass.exe",
    "dashlane.exe",
    "credentialuibroker.exe",
    // The system's own settings, tools and prompts.
    "systemsettings.exe",
    "regedit.exe",
    "taskmgr.exe",
    "mmc.exe",
    "control.exe",
    "consent.exe",
    "logonui.exe",
    // neema itself, when installed. In development it is the parent, refused below.
    "neema.exe",
];

/// The same for packaged apps, by a part of their AppUserModelID.
const OFF_LIMITS_AUMID: &[&str] = &[
    "windows.immersivecontrolpanel",
    "microsoft.windowsterminal",
    "1password",
    "bitwarden",
    "keepassxc",
];

/// The process that started the driver is neema, whatever its executable: in development it is
/// the generic electron.exe, so the name alone cannot tell.
fn parent_pid() -> u32 {
    static PARENT: OnceLock<u32> = OnceLock::new();
    *PARENT.get_or_init(|| {
        let me = unsafe { GetCurrentProcessId() };
        processes()
            .into_iter()
            .find(|p| p.0 == me)
            .map(|p| p.1)
            .unwrap_or(0)
    })
}

/// Every process as (pid, parent pid, executable name).
fn processes() -> Vec<(u32, u32, String)> {
    let mut found = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return found;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let end = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
            found.push((
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                String::from_utf16_lossy(&entry.szExeFile[..end]),
            ));
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    found
}

pub fn is_off_limits(app: &App, pid: u32) -> bool {
    let exe = file_name(&app.exe).to_lowercase();
    let id = app.app_id.to_lowercase();
    pid == parent_pid()
        || OFF_LIMITS_EXE.contains(&exe.as_str())
        || OFF_LIMITS_AUMID.iter().any(|part| id.contains(part))
}

fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

fn stem(path: &str) -> String {
    let name = file_name(path);
    name.strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".EXE"))
        .unwrap_or(name)
        .to_string()
}

fn is_path(app_id: &str) -> bool {
    app_id.len() > 3 && app_id.as_bytes()[1] == b':' && app_id.to_lowercase().ends_with(".exe")
}

/// Top-level app windows, front to back.
pub fn windows() -> Vec<Window> {
    unsafe extern "system" fn collect(hwnd: HWND, list: LPARAM) -> BOOL {
        unsafe { (*(list.0 as *mut Vec<HWND>)).push(hwnd) };
        true.into()
    }
    let mut found: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut found as *mut Vec<HWND> as isize));
    }
    found
        .into_iter()
        .filter(|&hwnd| is_app_window(hwnd))
        .map(|hwnd| Window {
            hwnd,
            pid: content_pid(hwnd),
        })
        .collect()
}

pub fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) } as usize;
    String::from_utf16_lossy(&buffer[..length])
}

pub fn title(hwnd: HWND) -> Option<String> {
    let mut buffer = [0u16; 512];
    let length = unsafe { GetWindowTextW(hwnd, &mut buffer) } as usize;
    (length > 0).then(|| String::from_utf16_lossy(&buffer[..length]))
}

fn is_app_window(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
            return false;
        }
        if GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid()) {
            return false;
        }
        if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        // Suspended Store apps and other virtual desktops' windows are cloaked: not on screen.
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            4,
        );
        if cloaked != 0 {
            return false;
        }
    }
    !matches!(
        class_name(hwnd).as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    )
}

pub fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// The content window inside a Store app's frame.
pub fn core_window(frame: HWND) -> Option<HWND> {
    if class_name(frame) != "ApplicationFrameWindow" {
        return None;
    }
    unsafe { FindWindowExW(Some(frame), None, w!("Windows.UI.Core.CoreWindow"), None) }.ok()
}

/// A Store app's frame belongs to ApplicationFrameHost; its content is the app's own process.
pub fn content_pid(hwnd: HWND) -> u32 {
    window_pid(core_window(hwnd).unwrap_or(hwnd))
}

/// The app's own process behind a window, unless it is a Store app's frame whose content is gone
/// (suspended): ApplicationFrameHost draws every Store app's frame, so it names none of them.
pub fn app_process(window: &Window) -> Option<u32> {
    let frame = class_name(window.hwnd) == "ApplicationFrameWindow";
    (!frame || window.pid != window_pid(window.hwnd)).then_some(window.pid)
}

fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let named = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        named.ok()?;
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

/// A packaged process's AppUserModelID; none for an ordinary one.
fn process_aumid(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 512];
        let mut length = buffer.len() as u32;
        let status =
            GetApplicationUserModelId(process, &mut length, Some(PWSTR(buffer.as_mut_ptr())));
        let _ = CloseHandle(process);
        (status == ERROR_SUCCESS && length > 1)
            .then(|| String::from_utf16_lossy(&buffer[..length as usize - 1]))
    }
}

fn window_aumid(hwnd: HWND) -> Option<String> {
    unsafe {
        let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
        let value = store.GetValue(&PKEY_AppUserModel_ID).ok()?;
        let text = value.to_string();
        (!text.is_empty()).then_some(text)
    }
}

/// The description an executable gives itself ("Microsoft Excel"), else its file name.
fn exe_name(path: &str) -> String {
    static CACHE: OnceLock<std::sync::Mutex<HashMap<String, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(name) = cache.lock().unwrap().get(path) {
        return name.clone();
    }
    let name = file_description(path).unwrap_or_else(|| stem(path));
    cache.lock().unwrap().insert(path.to_string(), name.clone());
    name
}

fn file_description(path: &str) -> Option<String> {
    unsafe {
        let file = wide(path);
        let size = GetFileVersionInfoSizeW(PCWSTR(file.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(
            PCWSTR(file.as_ptr()),
            None,
            size,
            data.as_mut_ptr() as *mut c_void,
        )
        .ok()?;
        let query = |key: &str| -> Option<(*mut c_void, u32)> {
            let mut pointer: *mut c_void = std::ptr::null_mut();
            let mut length = 0u32;
            let key = wide(key);
            VerQueryValueW(
                data.as_ptr() as *const c_void,
                PCWSTR(key.as_ptr()),
                &mut pointer,
                &mut length,
            )
            .as_bool()
            .then_some((pointer, length))
        };
        let mut languages = vec!["040904b0".to_string()];
        if let Some((pointer, length)) = query("\\VarFileInfo\\Translation")
            && length >= 4
        {
            let pair = pointer as *const u16;
            languages.insert(0, format!("{:04x}{:04x}", *pair, *pair.add(1)));
        }
        for language in languages {
            if let Some((pointer, length)) =
                query(&format!("\\StringFileInfo\\{language}\\FileDescription"))
                && length > 1
            {
                let text = std::slice::from_raw_parts(pointer as *const u16, length as usize - 1);
                let text = String::from_utf16_lossy(text).trim().to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
        None
    }
}

/// The name Start shows for a packaged app, looked up once: every call names every window's app.
fn aumid_name(aumid: &str) -> Option<String> {
    static CACHE: OnceLock<std::sync::Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(name) = cache.lock().unwrap().get(aumid) {
        return name.clone();
    }
    let name = shell_name(aumid);
    cache
        .lock()
        .unwrap()
        .insert(aumid.to_string(), name.clone());
    name
}

fn shell_name(aumid: &str) -> Option<String> {
    unsafe {
        let parsing = wide(&format!("shell:AppsFolder\\{aumid}"));
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(parsing.as_ptr()), None).ok()?;
        shell_string(item.GetDisplayName(SIGDN_NORMALDISPLAY).ok()?)
    }
}

fn shell_string(text: PWSTR) -> Option<String> {
    unsafe {
        let value = text.to_string().ok();
        CoTaskMemFree(Some(text.0 as *const c_void));
        value.filter(|value| !value.is_empty())
    }
}

/// The app a window shows. A Store app's frame whose content is suspended still names its app.
pub fn app_of(window: &Window) -> Option<App> {
    let exe = process_path(window.pid)?;
    let aumid = if file_name(&exe).eq_ignore_ascii_case("ApplicationFrameHost.exe") {
        window_aumid(window.hwnd)
    } else {
        process_aumid(window.pid)
    };
    Some(match aumid {
        Some(aumid) => App {
            name: aumid_name(&aumid).unwrap_or_else(|| exe_name(&exe)),
            app_id: aumid,
            exe,
            launch: None,
        },
        None => App {
            name: exe_name(&exe),
            app_id: squirrel_id(&exe).unwrap_or_else(|| exe.clone()),
            exe,
            launch: None,
        },
    })
}

/// An app installed by Squirrel (Discord, Slack, Teams classic) runs from a folder named after its
/// version, `app-1.0.9265\Discord.exe`, beside the `Update.exe` its Start entry runs. It is named
/// by its install folder instead, so its id survives updates and matches the Start entry's.
fn squirrel_id(exe: &str) -> Option<String> {
    let path = Path::new(exe);
    let version = path.parent()?;
    let install = version.parent()?;
    let versioned = version.file_name()?.to_str()?.starts_with("app-");
    let program = install.join(path.file_name()?);
    (versioned && install.join("Update.exe").exists())
        .then(|| program.to_string_lossy().into_owned())
}

/// The program a Squirrel Start entry starts: `Update.exe --processStart "Discord.exe"`.
fn squirrel_target(target: &str, arguments: &str) -> Option<String> {
    if !file_name(target).eq_ignore_ascii_case("Update.exe") {
        return None;
    }
    let (_, rest) = arguments.split_once("--processStart")?;
    let program = rest.trim_start().trim_start_matches('"');
    let program = program.split(['"', ' ']).next()?;
    let install = Path::new(target).parent()?;
    Some(install.join(program).to_string_lossy().into_owned())
}

pub struct Running {
    pub app: App,
    pub window: Window,
    pub front: bool,
    pub off_limits: bool,
}

/// Each running app once, by its frontmost window, front to back.
pub fn running() -> Vec<Running> {
    let front = unsafe { GetForegroundWindow() };
    let mut seen: Vec<Running> = Vec::new();
    for window in windows() {
        let Some(app) = app_of(&window) else { continue };
        if let Some(known) = seen
            .iter_mut()
            .find(|r| r.app.app_id.eq_ignore_ascii_case(&app.app_id))
        {
            known.front |= window.hwnd == front;
            continue;
        }
        seen.push(Running {
            off_limits: is_off_limits(&app, window.pid),
            front: window.hwnd == front,
            app,
            window,
        });
    }
    seen
}

/// The app `wanted` names among `apps`: by id, else by name, else by executable. A shortcut
/// that merely opens notepad.exe must not win over the app named Notepad.
fn named<'a, T>(apps: &'a [T], app: impl Fn(&T) -> &App, wanted: &str) -> Option<&'a T> {
    let tests: [&dyn Fn(&App) -> bool; 3] = [
        &|a| a.app_id.eq_ignore_ascii_case(wanted),
        &|a| a.name.eq_ignore_ascii_case(wanted),
        &|a| !a.exe.is_empty() && stem(&a.exe).eq_ignore_ascii_case(wanted),
    ];
    tests
        .iter()
        .find_map(|test| apps.iter().find(|entry| test(app(entry))))
}

/// The app's frontmost window. `pid` picks one instance where several share an id.
pub fn main_window(app_id: &str, pid: Option<u32>) -> Res<(Window, App)> {
    let (window, app) = frontmost(app_id, pid)?;
    Ok((with_dialog(window), app))
}

/// A dialog of a desktop app (Save As, a message box) is a window of its own, owned by the one
/// it blocks: while it is open, it is what can be used.
fn with_dialog(window: Window) -> Window {
    unsafe {
        if let Ok(popup) = GetWindow(window.hwnd, GW_ENABLEDPOPUP)
            && !popup.is_invalid()
            && popup != window.hwnd
            && IsWindowVisible(popup).as_bool()
        {
            return Window {
                hwnd: popup,
                pid: window.pid,
            };
        }
    }
    window
}

fn frontmost(app_id: &str, pid: Option<u32>) -> Res<(Window, App)> {
    let mut refused = false;
    for running in running() {
        if !running.app.app_id.eq_ignore_ascii_case(app_id) {
            continue;
        }
        if running.off_limits {
            refused = true;
            continue;
        }
        if pid.is_some_and(|pid| pid != running.window.pid) {
            // Another instance's windows may come later in the z-order.
            if let Some(window) = windows().into_iter().find(|w| Some(w.pid) == pid) {
                return Ok((window, running.app));
            }
            continue;
        }
        return Ok((running.window, running.app));
    }
    if refused {
        return fail("off_limits", format!("{app_id} is never used"));
    }
    let executable = if is_path(app_id) {
        file_name(app_id).to_lowercase()
    } else {
        String::new()
    };
    if !executable.is_empty() && processes().iter().any(|p| p.2.to_lowercase() == executable) {
        return fail("no_window", format!("{app_id} has no open window"));
    }
    fail("not_running", format!("{app_id} is not running"))
}

pub struct Resolved {
    pub app_id: String,
    pub name: String,
    pub running: bool,
    launch: Option<String>,
}

/// Which app an id or a name means, running or installed, without starting it: what consent
/// is asked about.
pub fn resolve(wanted: &str) -> Res<Resolved> {
    let running = running();
    if let Some(found) = named(&running, |r| &r.app, wanted) {
        if found.off_limits {
            return fail("off_limits", format!("{wanted} is never used"));
        }
        return Ok(Resolved {
            app_id: found.app.app_id.clone(),
            name: found.app.name.clone(),
            running: true,
            launch: None,
        });
    }
    let found = if is_path(wanted) && Path::new(wanted).exists() {
        Some(App {
            app_id: wanted.to_string(),
            name: exe_name(wanted),
            exe: wanted.to_string(),
            launch: None,
        })
    } else {
        let installed = installed();
        named(&installed, |app| app, wanted).cloned()
    };
    let Some(app) = found else {
        return fail("not_installed", format!("{wanted} is not installed"));
    };
    if is_off_limits(&app, 0) {
        return fail("off_limits", format!("{wanted} is never used"));
    }
    Ok(Resolved {
        app_id: app.app_id,
        name: app.name,
        running: false,
        launch: app.launch,
    })
}

/// Apps as Start lists them. A desktop app is named by its executable, as when it runs.
fn installed() -> Vec<App> {
    let mut apps = Vec::new();
    unsafe {
        let Ok(folder) =
            SHGetKnownFolderItem::<IShellItem>(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)
        else {
            return apps;
        };
        let Ok(items) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) else {
            return apps;
        };
        loop {
            let mut batch = [None];
            let mut fetched = 0u32;
            if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(item) = batch[0].take() else { break };
            let Some(name) = item
                .GetDisplayName(SIGDN_NORMALDISPLAY)
                .ok()
                .and_then(shell_string)
            else {
                continue;
            };
            let Some(aumid) = item
                .GetDisplayName(SIGDN_PARENTRELATIVEPARSING)
                .ok()
                .and_then(shell_string)
            else {
                continue;
            };
            let link = item.cast::<IShellItem2>().ok();
            let read = |key| {
                link.as_ref()
                    .and_then(|link| link.GetString(key).ok())
                    .and_then(shell_string)
            };
            let target = read(&PKEY_Link_TargetParsingPath).or_else(|| known_folder_path(&aumid));
            let arguments = read(&PKEY_Link_Arguments).unwrap_or_default();
            match target.filter(|path| path.to_lowercase().ends_with(".exe")) {
                Some(target) => {
                    let exe = squirrel_target(&target, &arguments).unwrap_or(target);
                    apps.push(App {
                        app_id: exe.clone(),
                        name,
                        exe,
                        launch: Some(format!("shell:AppsFolder\\{aumid}")),
                    })
                }
                None => apps.push(App {
                    app_id: aumid,
                    name,
                    exe: String::new(),
                    launch: None,
                }),
            }
        }
    }
    apps
}

/// `{known folder guid}\relative\app.exe`, the id Windows makes up for a desktop app, as a path.
fn known_folder_path(aumid: &str) -> Option<String> {
    let (guid, rest) = aumid.strip_prefix('{')?.split_once("}\\")?;
    let guid = GUID::try_from(guid).ok()?;
    let folder = unsafe { shell_string(SHGetKnownFolderPath(&guid, KF_FLAG_DEFAULT, None).ok()?) }?;
    Some(format!("{folder}\\{rest}"))
}

/// Opens an app, or brings back a minimized window of one that runs, and waits for a window.
pub fn open(wanted: &str) -> Res<(App, u32)> {
    let resolved = resolve(wanted)?;
    if let Ok((window, app)) = main_window(&resolved.app_id, None) {
        if unsafe { IsIconic(window.hwnd) }.as_bool() {
            unsafe {
                let _ = ShowWindow(window.hwnd, SW_SHOWNOACTIVATE);
            }
        }
        return Ok((app, window.pid));
    }
    let launched = match &resolved.launch {
        Some(entry) => launch_path(entry)?,
        None if is_path(&resolved.app_id) => launch_path(&resolved.app_id)?,
        None => activate(&resolved.app_id)?,
    };
    // An app is launched before its first window exists, and a look right away found none.
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok((window, app)) = main_window(&resolved.app_id, None) {
            return Ok((app, window.pid));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let app = App {
        app_id: resolved.app_id,
        name: resolved.name,
        exe: String::new(),
        launch: None,
    };
    Ok((app, launched))
}

fn launch_path(path: &str) -> Res<u32> {
    let file = wide(path);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI,
        lpVerb: w!("open"),
        lpFile: PCWSTR(file.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe {
        if ShellExecuteExW(&mut info).is_err() {
            return fail("not_installed", format!("{path} could not be started"));
        }
        // A shell item may start through a broker and hand back no process.
        if info.hProcess.is_invalid() {
            return Ok(0);
        }
        let pid = GetProcessId(info.hProcess);
        let _ = CloseHandle(info.hProcess);
        Ok(pid)
    }
}

/// A packaged app is started through its AppUserModelID; the process ShellExecute would report
/// for Windows' own stubs (notepad.exe, calc.exe) exits at once.
fn activate(aumid: &str) -> Res<u32> {
    unsafe {
        let manager: IApplicationActivationManager =
            CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER)?;
        let id = wide(aumid);
        match manager.ActivateApplication(PCWSTR(id.as_ptr()), PCWSTR::null(), AO_NONE) {
            Ok(pid) => Ok(pid),
            Err(_) => fail("not_installed", format!("{aumid} could not be started")),
        }
    }
}

/// Locked, or showing a UAC prompt: input goes to another desktop than the person's.
pub fn screen_locked() -> bool {
    unsafe {
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return true;
        };
        let mut name = [0u16; 64];
        let mut needed = 0u32;
        let read = GetUserObjectInformationW(
            windows::Win32::Foundation::HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr() as *mut c_void),
            (name.len() * 2) as u32,
            Some(&mut needed),
        );
        let _ = CloseDesktop(desktop);
        let end = name.iter().position(|&c| c == 0).unwrap_or(0);
        read.is_err() || !String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("Default")
    }
}
