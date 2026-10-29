//! The Windows app driver: one JSON request per line on stdin, one response per line on stdout,
//! as apps/desktop/src/app-use/protocol.ts specifies. Started by the desktop app, never on its
//! own; it exits when its input closes. See docs/internals/app-use.md.

mod apps;
mod capture;
mod driver;
mod error;
mod input;
mod keys;
mod person;
mod tree;

use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::time::Duration;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};

pub fn send(response: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{response}");
    let _ = out.flush();
}

/// The longest a request may take. An app whose accessibility or drawing hangs (LibreOffice's
/// UI Automation does, after Cua) would otherwise hold every later request; opening an app waits
/// up to 10 s for its window, so this is longer.
const DEADLINE: Duration = Duration::from_secs(20);

fn failed(line: &str, message: &str) -> Value {
    let id =
        serde_json::from_str::<Value>(line).map_or(Value::Null, |request| request["id"].clone());
    json!({ "id": id, "error": { "code": "failed", "message": message } })
}

/// A thread with COM that handles requests in order and answers each on `answers`.
struct Worker {
    requests: mpsc::Sender<String>,
    answers: mpsc::Receiver<Value>,
}

impl Worker {
    fn start() -> Self {
        let (requests, queue) = mpsc::channel::<String>();
        let (answer, answers) = mpsc::channel();
        std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED).ok();
            }
            let mut driver = driver::Driver::new();
            for line in queue {
                // A fault in one request is answered as a failure, and the next still runs.
                let answered =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| driver.handle(&line)))
                        .unwrap_or_else(|_| failed(&line, "The driver failed on that request"));
                // Nobody listens once the worker was given up on.
                if answer.send(answered).is_err() {
                    break;
                }
            }
        });
        Self { requests, answers }
    }
}

fn main() {
    // Window rectangles, element frames, captures and input then all speak physical pixels.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    person::watch();

    // One request at a time, in arrival order, so an action never races the look it refers to.
    let (requests, queue) = mpsc::channel::<String>();
    let supervisor = std::thread::spawn(move || {
        let mut worker = Worker::start();
        for line in queue {
            let _ = worker.requests.send(line.clone());
            match worker.answers.recv_timeout(DEADLINE) {
                Ok(answer) => send(&answer),
                Err(_) => {
                    send(&failed(
                        &line,
                        "The app is not responding, so neema stopped waiting; what was asked may still happen. Try again later.",
                    ));
                    // The stuck thread is left behind, its answer unheard, and a fresh one serves
                    // the next request: it holds no look, so actions start from a new one.
                    worker = Worker::start();
                }
            }
        }
    });

    // The reader never waits for a request: a call that never returns must not keep the driver
    // from seeing its input close, which is how it learns the app that started it is gone.
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        // Windows has no permission guide; closing one never queues behind other calls.
        if let Ok(request) = serde_json::from_str::<Value>(&line)
            && request["method"] == "cancelGuide"
        {
            send(&json!({ "id": request["id"], "result": {} }));
            continue;
        }
        if requests.send(line).is_err() {
            break;
        }
    }
    drop(requests);
    // What was asked before the input closed is answered, unless it is stuck.
    let (done, finished) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = supervisor.join();
        let _ = done.send(());
    });
    let _ = finished.recv_timeout(Duration::from_secs(2));
    std::process::exit(0);
}
