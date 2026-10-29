/// A failure the desktop app understands: `code` is one of the protocol's `DriverErrorCode`s.
#[derive(Debug)]
pub struct DriverError {
    pub code: &'static str,
    pub message: String,
}

pub type Res<T> = Result<T, DriverError>;

pub fn fail<T>(code: &'static str, message: impl Into<String>) -> Res<T> {
    Err(DriverError {
        code,
        message: message.into(),
    })
}

/// UI Automation's answer when the app did not reply within its connection timeout (2 s).
const UIA_E_TIMEOUT: i32 = 0x8013_1505_u32 as i32;

impl From<windows::core::Error> for DriverError {
    fn from(error: windows::core::Error) -> Self {
        let message = match error.code().0 {
            UIA_E_TIMEOUT => "The app is not responding. Try again later.".to_string(),
            // Many HRESULTs have no text, and an empty message tells the model nothing.
            _ if error.message().is_empty() => format!("Windows failed ({})", error.code()),
            _ => error.message(),
        };
        DriverError {
            code: "failed",
            message,
        }
    }
}
