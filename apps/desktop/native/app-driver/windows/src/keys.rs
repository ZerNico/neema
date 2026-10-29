//! `cmd+shift+s`, `Return`, `ctrl+Tab` as virtual keys. The model learns shortcuts in macOS's
//! words, so `cmd` is Windows' Ctrl; `win` is the Windows key.

use crate::error::{Res, fail};
use windows::Win32::UI::Input::KeyboardAndMouse::VkKeyScanW;

pub const SHIFT: u16 = 0x10;
pub const CONTROL: u16 = 0x11;
pub const ALT: u16 = 0x12;
pub const WINDOWS: u16 = 0x5B;
pub const RETURN: u16 = 0x0D;
pub const TAB: u16 = 0x09;

pub struct Chord {
    pub modifiers: Vec<u16>,
    pub key: u16,
}

pub fn modifier(name: &str) -> Option<u16> {
    match name.to_lowercase().as_str() {
        "cmd" | "command" | "ctrl" | "control" => Some(CONTROL),
        "alt" | "option" | "opt" => Some(ALT),
        "shift" => Some(SHIFT),
        "win" | "windows" | "super" | "meta" => Some(WINDOWS),
        _ => None,
    }
}

fn named(name: &str) -> Option<u16> {
    Some(match name.to_lowercase().as_str() {
        "return" | "enter" => RETURN,
        "tab" => TAB,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "insert" => 0x2D,
        "escape" | "esc" => 0x1B,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "left" | "arrowleft" => 0x25,
        "up" | "arrowup" => 0x26,
        "right" | "arrowright" => 0x27,
        "down" | "arrowdown" => 0x28,
        name if name.len() > 1 && name.starts_with('f') => {
            let number: u16 = name[1..].parse().ok()?;
            if !(1..=24).contains(&number) {
                return None;
            }
            0x6F + number
        }
        _ => return None,
    })
}

/// Reads a chord. Modifiers are not case sensitive; a single character is found on the current
/// keyboard layout, and a capital asks for shift, as "S" would be typed.
pub fn parse(text: &str) -> Res<Chord> {
    let parts: Vec<&str> = text.split('+').collect();
    // "cmd++" means cmd and the plus key.
    let (key_part, modifier_parts) = if text.ends_with("++") {
        ("+", &parts[..parts.len().saturating_sub(2)])
    } else {
        (
            *parts.last().unwrap_or(&""),
            &parts[..parts.len().saturating_sub(1)],
        )
    };
    let mut modifiers = Vec::new();
    for part in modifier_parts {
        let Some(found) = modifier(part) else {
            return fail("invalid_params", format!("Unknown modifier {part}"));
        };
        if !modifiers.contains(&found) {
            modifiers.push(found);
        }
    }
    if let Some(key) = named(key_part) {
        return Ok(Chord { modifiers, key });
    }
    let mut characters = key_part.chars();
    let (Some(character), None) = (characters.next(), characters.next()) else {
        return fail("invalid_params", format!("Unknown key {key_part}"));
    };
    let key = match character.to_ascii_uppercase() {
        // Letters and digits by their own codes, whatever the layout.
        upper @ ('A'..='Z' | '0'..='9') => {
            if character.is_ascii_uppercase() && !modifiers.contains(&SHIFT) {
                modifiers.push(SHIFT);
            }
            upper as u16
        }
        _ => {
            let mut units = [0u16; 2];
            let encoded = character.encode_utf16(&mut units);
            if encoded.len() != 1 {
                return fail("invalid_params", format!("Unknown key {key_part}"));
            }
            let scan = unsafe { VkKeyScanW(encoded[0]) };
            if scan == -1 {
                return fail(
                    "invalid_params",
                    format!("No key types {key_part} on this keyboard"),
                );
            }
            let shift = (scan >> 8) & 0xFF;
            for (bit, key) in [(1, SHIFT), (2, CONTROL), (4, ALT)] {
                if shift & bit != 0 && !modifiers.contains(&key) {
                    modifiers.push(key);
                }
            }
            (scan & 0xFF) as u16
        }
    };
    Ok(Chord { modifiers, key })
}

/// Keys whose scan codes need the extended flag, or they arrive as the number pad's.
pub fn extended(key: u16) -> bool {
    matches!(
        key,
        0x21..=0x28 | 0x2D | 0x2E | 0x5B | 0x5C | 0x6F | 0xA3 | 0xA5
    )
}
