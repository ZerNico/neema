//! Requests, one at a time: what a look holds, and every action going through `acting`.

use crate::apps;
use crate::capture::{self, Capturer, LOOK_EDGE, PEEK_EDGE};
use crate::error::{DriverError, Res, fail};
use crate::input::{self, Target};
use crate::keys;
use crate::person;
use crate::tree::{self, Snapshot};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::RECT;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::UI::Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomation2};
use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow, SW_SHOWNOACTIVATE, ShowWindow};
use windows::core::Interface;

/// What the latest look was of. Actions go to it; node ids name its elements.
struct Looked {
    window: apps::Window,
    app_id: String,
}

#[derive(Default)]
pub struct Driver {
    uia: Option<IUIAutomation>,
    snapshot: Snapshot,
    capturer: Capturer,
    looked: Option<Looked>,
}

impl Driver {
    pub fn new() -> Self {
        Self::default()
    }

    /// The response to one request line.
    pub fn handle(&mut self, line: &str) -> Value {
        let request = serde_json::from_str::<Value>(line).unwrap_or_default();
        let (Some(id), Some(method)) = (request.get("id"), request["method"].as_str()) else {
            return json!({ "id": null, "error": { "code": "bad_request", "message": "Not a request" } });
        };
        let params = request.get("params").cloned().unwrap_or(json!({}));
        match self.run(method, &params) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => {
                json!({ "id": id, "error": { "code": error.code, "message": error.message } })
            }
        }
    }

    fn run(&mut self, method: &str, params: &Value) -> Res<Value> {
        // A locked computer shows another desktop, where no app window is.
        if !matches!(method, "permissions" | "apps" | "guide" | "resolve") && apps::screen_locked()
        {
            return fail("screen_locked", "The computer is locked");
        }
        match method {
            // Nothing to grant on Windows: UI Automation and window capture need no permission.
            "permissions" => Ok(json!({
                "accessibility": true,
                "capture": true,
                "background": false,
            })),
            "guide" => Ok(json!({ "outcome": "granted" })),
            "apps" => Ok(json!({
                "apps": apps::running().iter().map(|running| json!({
                    "appId": running.app.app_id,
                    "name": running.app.name,
                    "pid": running.window.pid,
                    "front": running.front,
                    "offLimits": running.off_limits,
                })).collect::<Vec<_>>(),
            })),
            "resolve" => {
                let resolved = apps::resolve(string(params, "app")?)?;
                Ok(
                    json!({ "appId": resolved.app_id, "name": resolved.name, "running": resolved.running }),
                )
            }
            "open" => {
                let (app, pid) = apps::open(string(params, "appId")?)?;
                Ok(json!({ "name": app.name, "pid": pid, "appId": app.app_id }))
            }
            "look" => self.look(
                string(params, "appId")?,
                params["pid"].as_u64().map(|pid| pid as u32),
            ),
            "zoom" => self.zoom(params),
            "peek" => self.peek(),
            "click" => self.click(params),
            "setValue" => {
                self.acting()?;
                let element = self.snapshot.element(string(params, "node")?)?;
                tree::set_value(&element, string(params, "value")?)?;
                Ok(json!({}))
            }
            "type" => {
                let text = string(params, "text")?;
                let target = self.acting()?;
                let element = match params["node"].as_str() {
                    Some(id) => Some(self.snapshot.element(id)?),
                    None => None,
                };
                input::foreground(&target)?;
                if let Some(element) = element {
                    tree::focus(&element);
                    std::thread::sleep(Duration::from_millis(50));
                }
                input::type_text(&target, text)?;
                Ok(json!({ "inserted": false }))
            }
            "key" => {
                let chord = keys::parse(string(params, "keys")?)?;
                let target = self.acting()?;
                input::foreground(&target)?;
                input::press(&chord)?;
                Ok(json!({}))
            }
            "scroll" => {
                let target = self.acting()?;
                let at = self.place(&params["at"], &target)?;
                input::foreground(&target)?;
                input::lands_on(&target, at)?;
                let lines = |key: &str| params[key].as_i64().unwrap_or(0).clamp(-100, 100) as i32;
                input::scroll(at, lines("x"), lines("y"))?;
                Ok(json!({}))
            }
            "drag" => {
                let target = self.acting()?;
                let (from, to) = (
                    self.place(&params["from"], &target)?,
                    self.place(&params["to"], &target)?,
                );
                input::foreground(&target)?;
                input::lands_on(&target, from)?;
                input::drag(from, to)?;
                Ok(json!({}))
            }
            _ => fail("unknown_method", format!("No method {method}")),
        }
    }

    fn uia(&mut self) -> Res<IUIAutomation> {
        if let Some(uia) = &self.uia {
            return Ok(uia.clone());
        }
        let uia: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)? };
        // A hung app would otherwise hold every call for UI Automation's own long timeouts.
        if let Ok(timed) = uia.cast::<IUIAutomation2>() {
            unsafe {
                let _ = timed.SetConnectionTimeout(2000);
                let _ = timed.SetTransactionTimeout(5000);
            }
        }
        self.uia = Some(uia.clone());
        Ok(uia)
    }

    fn look(&mut self, app_id: &str, pid: Option<u32>) -> Res<Value> {
        let (window, app) = apps::main_window(app_id, pid)?;
        let hwnd = window.hwnd;
        // A minimized window has nothing to capture or click: it is shown again, without focus.
        if unsafe { IsIconic(hwnd) }.as_bool() {
            unsafe {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
            let deadline = Instant::now() + Duration::from_secs(1);
            while unsafe { IsIconic(hwnd) }.as_bool() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let bounds = capture::bounds(hwnd)?;
        // Elements of a Store app's frame (its title bar) are ApplicationFrameHost's.
        let pids = vec![window.pid, apps::window_pid(hwnd)];
        let uia = self.uia()?;
        let mut walked = self.snapshot.take(&uia, hwnd, bounds, pids.clone())?;
        // Chromium builds its page's tree once a client asks for it, a moment after.
        if walked.web_missing {
            std::thread::sleep(Duration::from_millis(700));
            walked = self.snapshot.take(&uia, hwnd, bounds, pids)?;
        }
        let shot = self.capturer.capture(hwnd)?;
        let picture = capture::picture(&shot, None, LOOK_EDGE)?;
        self.looked = Some(Looked {
            window,
            app_id: app.app_id.clone(),
        });
        Ok(json!({
            "app": app.name,
            "title": apps::title(hwnd),
            "window": { "width": bounds.right - bounds.left, "height": bounds.bottom - bounds.top },
            "image": { "data": picture.data, "width": picture.width, "height": picture.height },
            "nodes": walked.nodes,
            "truncated": walked.truncated,
        }))
    }

    /// The looked window, where it is now: it may have moved since the look.
    fn current(&self) -> Res<(Target, RECT)> {
        let Some(looked) = &self.looked else {
            return fail("no_look", "Look at the app first");
        };
        let window = looked.window;
        if !unsafe { IsWindow(Some(window.hwnd)) }.as_bool() {
            return fail("no_window", "The window is gone");
        }
        if apps::app_of(&window).is_some_and(|app| apps::is_off_limits(&app, window.pid)) {
            return fail("off_limits", format!("{} is never used", looked.app_id));
        }
        Ok((
            Target {
                hwnd: window.hwnd,
                app: apps::app_process(&window),
            },
            capture::bounds(window.hwnd)?,
        ))
    }

    /// Every action in the person's apps comes through here. It waits for no one but the person:
    /// while they are using the app it is refused, and they finish first.
    fn acting(&self) -> Res<Target> {
        let (target, _) = self.current()?;
        let wait = person::busy(&target);
        if wait > 0.0 {
            return fail(
                "person_active",
                format!(
                    "The person is using the app; try again in {} s",
                    wait.ceil() as u32
                ),
            );
        }
        let processes = [Some(apps::window_pid(target.hwnd)), target.app];
        if processes.into_iter().flatten().any(input::above_us) {
            return fail(
                "action_failed",
                "The app runs as administrator, so neema cannot act in it",
            );
        }
        Ok(target)
    }

    /// A place on the screen: a point in the looked window's pixels, or a node's centre.
    fn place(&self, place: &Value, _target: &Target) -> Res<(i32, i32)> {
        if let (Some(x), Some(y)) = (place["x"].as_f64(), place["y"].as_f64()) {
            let (_, bounds) = self.current()?;
            return Ok((
                bounds.left + x.round() as i32,
                bounds.top + y.round() as i32,
            ));
        }
        if let Some(id) = place["node"].as_str() {
            return tree::centre(&self.snapshot.element(id)?);
        }
        fail("invalid_params", "Missing a point or a node")
    }

    fn click(&mut self, params: &Value) -> Res<Value> {
        let target = self.acting()?;
        let button = params["button"].as_str().unwrap_or("left");
        let count = params["count"].as_u64().unwrap_or(1).clamp(1, 3) as u32;
        let mut modifiers = Vec::new();
        for name in params["modifiers"].as_array().into_iter().flatten() {
            let name = name.as_str().unwrap_or_default();
            let Some(key) = keys::modifier(name) else {
                return fail("invalid_params", format!("Unknown modifier {name}"));
            };
            modifiers.push(key);
        }
        // A plain click on an element that can be pressed is a press: no pointer, no focus taken.
        if let Some(id) = params["node"].as_str()
            && button == "left"
            && count == 1
            && modifiers.is_empty()
            && input::pressing(&target, || tree::press(&self.snapshot.element(id)?))?
        {
            return Ok(json!({}));
        }
        let at = if params["at"].is_object() {
            self.place(&params["at"], &target)?
        } else {
            self.place(&json!({ "node": params["node"] }), &target)?
        };
        input::foreground(&target)?;
        input::lands_on(&target, at)?;
        input::click(at, button, count, &modifiers)?;
        Ok(json!({}))
    }

    fn zoom(&mut self, params: &Value) -> Res<Value> {
        let region = &params["region"];
        let (Some(x), Some(y), Some(width), Some(height)) = (
            region["x"].as_f64(),
            region["y"].as_f64(),
            region["width"].as_f64(),
            region["height"].as_f64(),
        ) else {
            return fail("invalid_params", "Missing or invalid region");
        };
        if width <= 0.0 || height <= 0.0 {
            return fail("invalid_params", "Missing or invalid region");
        }
        let (target, bounds) = self.current()?;
        let shot = self.capturer.capture(target.hwnd)?;
        // The shot is the window at its own resolution; the region is in window pixels.
        let scale = shot.width as f64 / (bounds.right - bounds.left) as f64;
        let part = RECT {
            left: (x * scale) as i32,
            top: (y * scale) as i32,
            right: ((x + width) * scale).ceil() as i32,
            bottom: ((y + height) * scale).ceil() as i32,
        };
        let picture = capture::picture(&shot, Some(part), LOOK_EDGE)?;
        Ok(json!({ "data": picture.data, "width": picture.width, "height": picture.height }))
    }

    /// A small picture of the window being driven, for the person's live view.
    fn peek(&mut self) -> Res<Value> {
        let (target, _) = self.current()?;
        let shot = self.capturer.capture_often(target.hwnd)?;
        let picture = capture::picture(&shot, None, PEEK_EDGE)?;
        Ok(json!({ "data": picture.data, "width": picture.width, "height": picture.height }))
    }
}

fn string<'a>(params: &'a Value, key: &str) -> Res<&'a str> {
    params[key].as_str().ok_or_else(|| DriverError {
        code: "invalid_params",
        message: format!("Missing {key}"),
    })
}
