//! One window's picture, never the screen: Windows.Graphics.Capture, which also reads a covered
//! window, and PrintWindow where it cannot. Pictures go back as PNG within a longest edge.

use crate::error::{Res, fail};
use std::ffi::c_void;
use std::time::{Duration, Instant};
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
    DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
use windows::core::Interface;

/// The longest edge of a look's picture. The desktop app scales between its pixels and the
/// window's, as on macOS.
pub const LOOK_EDGE: u32 = 1280;
/// The live view's pictures are small; it shows them in a panel.
pub const PEEK_EDGE: u32 = 640;

/// Top-down BGRA pixels of a whole window.
pub struct Shot {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub struct Picture {
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// The window as it is drawn, without the invisible margin its shadow takes: what a person
/// calls the window, and what a capture shows.
pub fn bounds(hwnd: HWND) -> Res<RECT> {
    let mut rect = RECT::default();
    unsafe {
        let measured = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        );
        if measured.is_err() {
            GetWindowRect(hwnd, &mut rect).map_err(|_| no_window())?;
        }
    }
    if rect.right <= rect.left || rect.bottom <= rect.top {
        return Err(no_window());
    }
    Ok(rect)
}

fn no_window() -> crate::error::DriverError {
    crate::error::DriverError {
        code: "no_window",
        message: "The window is gone".into(),
    }
}

#[derive(Default)]
pub struct Capturer {
    device: Option<(ID3D11Device, ID3D11DeviceContext, IDirect3DDevice)>,
}

impl Capturer {
    /// The window's picture at its own resolution.
    pub fn capture(&mut self, hwnd: HWND) -> Res<Shot> {
        if let Ok(shot) = self.graphics_capture(hwnd)
            && !mostly_black(&shot)
        {
            return Ok(shot);
        }
        // Some surfaces never come through Graphics Capture; PrintWindow asks the window itself.
        match print_window(hwnd) {
            Ok(shot) if !mostly_black(&shot) => Ok(shot),
            _ => fail("capture_failed", "The window could not be captured"),
        }
    }

    /// The same, PrintWindow first: the live view asks four times a second, and a Graphics
    /// Capture session made and closed each time costs more, and flashes a border where Windows
    /// insists on one.
    pub fn capture_often(&mut self, hwnd: HWND) -> Res<Shot> {
        match print_window(hwnd) {
            Ok(shot) if !mostly_black(&shot) => Ok(shot),
            _ => self.capture(hwnd),
        }
    }

    fn graphics_capture(&mut self, hwnd: HWND) -> Res<Shot> {
        if !GraphicsCaptureSession::IsSupported()? {
            return fail("capture_failed", "Graphics capture is not supported");
        }
        let (d3d, context, device) = self.device()?;
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd)? };
        let size = item.Size()?;
        if size.Width <= 0 || size.Height <= 0 {
            return fail("capture_failed", "The window is hidden");
        }
        // Free-threaded and polled: a pool tied to a dispatcher, or its FrameArrived event,
        // needs a message loop this thread does not run (Cua measured the event never firing).
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            size,
        )?;
        let session = pool.CreateCaptureSession(&item)?;
        // The yellow border says a capture runs; Windows may insist on it, which is fine.
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetIsCursorCaptureEnabled(false);
        session.StartCapture()?;
        let close = || {
            let _ = session.Close();
            let _ = pool.Close();
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        let frame = loop {
            if let Ok(frame) = pool.TryGetNextFrame() {
                break frame;
            }
            if Instant::now() > deadline {
                close();
                return fail("capture_failed", "The window sent no picture");
            }
            std::thread::sleep(Duration::from_millis(15));
        };
        let content = frame.ContentSize()?;
        let texture: ID3D11Texture2D = unsafe {
            frame
                .Surface()?
                .cast::<IDirect3DDxgiInterfaceAccess>()?
                .GetInterface()?
        };
        let shot = unsafe { read_texture(&d3d, &context, &texture, content.Width, content.Height) };
        let _ = frame.Close();
        close();
        shot
    }

    fn device(&mut self) -> Res<(ID3D11Device, ID3D11DeviceContext, IDirect3DDevice)> {
        if let Some(device) = &self.device {
            return Ok(device.clone());
        }
        let mut d3d = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut d3d),
                None,
                Some(&mut context),
            )?;
        }
        let d3d: ID3D11Device = d3d.ok_or_else(|| missing("Direct3D device"))?;
        let context = context.ok_or_else(|| missing("Direct3D context"))?;
        let dxgi: IDXGIDevice = d3d.cast()?;
        let device: IDirect3DDevice =
            unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
        self.device = Some((d3d, context, device));
        Ok(self.device.clone().unwrap())
    }
}

fn missing(what: &str) -> crate::error::DriverError {
    crate::error::DriverError {
        code: "capture_failed",
        message: format!("No {what}"),
    }
}

unsafe fn read_texture(
    d3d: &ID3D11Device,
    context: &ID3D11DeviceContext,
    texture: &ID3D11Texture2D,
    width: i32,
    height: i32,
) -> Res<Shot> {
    unsafe {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging = None;
        d3d.CreateTexture2D(&desc, None, Some(&mut staging))?;
        let staging = staging.ok_or_else(|| missing("staging texture"))?;
        context.CopyResource(&staging, texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let width = (width.max(0) as u32).min(desc.Width);
        let height = (height.max(0) as u32).min(desc.Height);
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        // Rows may be padded beyond the picture's width.
        for row in 0..height as usize {
            let start = (mapped.pData as *const u8).add(row * mapped.RowPitch as usize);
            pixels.extend_from_slice(std::slice::from_raw_parts(start, width as usize * 4));
        }
        context.Unmap(&staging, 0);
        Ok(Shot {
            pixels,
            width,
            height,
        })
    }
}

/// PW_RENDERFULLCONTENT: the window's composed content, Chromium and XAML surfaces included.
const RENDER_FULL_CONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

fn print_window(hwnd: HWND) -> Res<Shot> {
    unsafe {
        // Both measured now: one from before could disagree with a window moved since.
        let bounds = self::bounds(hwnd)?;
        let mut whole = RECT::default();
        GetWindowRect(hwnd, &mut whole).map_err(|_| no_window())?;
        let (width, height) = (whole.right - whole.left, whole.bottom - whole.top);
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0);
        let result = match bitmap {
            Ok(bitmap) => {
                let previous = SelectObject(dc, bitmap.into());
                let printed = PrintWindow(hwnd, dc, RENDER_FULL_CONTENT).as_bool();
                let all =
                    std::slice::from_raw_parts(bits as *const u8, (width * height * 4) as usize);
                // The drawn window sits inside the whole one, its shadow margin around it.
                let left = (bounds.left - whole.left).clamp(0, width);
                let top = (bounds.top - whole.top).clamp(0, height);
                let (inner_width, inner_height) = (
                    (bounds.right - bounds.left).clamp(0, width - left),
                    (bounds.bottom - bounds.top).clamp(0, height - top),
                );
                let mut pixels =
                    Vec::with_capacity((inner_width * inner_height * 4).max(0) as usize);
                for row in top..top + inner_height {
                    let start = ((row * width + left) * 4) as usize;
                    pixels.extend_from_slice(&all[start..start + inner_width as usize * 4]);
                }
                // GDI leaves alpha unset.
                for alpha in pixels.iter_mut().skip(3).step_by(4) {
                    *alpha = 255;
                }
                SelectObject(dc, previous);
                let _ = DeleteObject(bitmap.into());
                if printed {
                    Ok(Shot {
                        pixels,
                        width: inner_width as u32,
                        height: inner_height as u32,
                    })
                } else {
                    fail("capture_failed", "The window did not draw itself")
                }
            }
            Err(error) => Err(error.into()),
        };
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        result
    }
}

/// A surface that could not be read comes back black; a blank black window is rare enough.
fn mostly_black(shot: &Shot) -> bool {
    let pixels: Vec<&[u8]> = shot.pixels.chunks_exact(4).step_by(97).collect();
    if pixels.is_empty() {
        return true;
    }
    let black = pixels
        .iter()
        .filter(|p| p[0] == 0 && p[1] == 0 && p[2] == 0)
        .count();
    black * 1000 >= pixels.len() * 995
}

/// A part of the shot (in its own pixels), scaled within `max_edge`, as base64 PNG.
pub fn picture(shot: &Shot, region: Option<RECT>, max_edge: u32) -> Res<Picture> {
    let region = region.unwrap_or(RECT {
        left: 0,
        top: 0,
        right: shot.width as i32,
        bottom: shot.height as i32,
    });
    let left = region.left.clamp(0, shot.width as i32) as u32;
    let top = region.top.clamp(0, shot.height as i32) as u32;
    let right = region.right.clamp(0, shot.width as i32) as u32;
    let bottom = region.bottom.clamp(0, shot.height as i32) as u32;
    if right <= left || bottom <= top {
        return fail("invalid_params", "That part is outside the window");
    }
    let (width, height) = (right - left, bottom - top);
    let fit = (width.max(height) as f64 / max_edge as f64).max(1.0);
    let (out_width, out_height) = (
        ((width as f64 / fit).round() as u32).max(1),
        ((height as f64 / fit).round() as u32).max(1),
    );
    // Averages each block of source pixels, so text stays legible when shrunk.
    let mut rgba = Vec::with_capacity((out_width * out_height * 4) as usize);
    for y in 0..out_height {
        let y0 = top + y * height / out_height;
        let y1 = (top + (y + 1) * height / out_height).max(y0 + 1);
        for x in 0..out_width {
            let x0 = left + x * width / out_width;
            let x1 = (left + (x + 1) * width / out_width).max(x0 + 1);
            let mut sum = [0u32; 4];
            for sy in y0..y1 {
                let row = (sy * shot.width) as usize * 4;
                for sx in x0..x1 {
                    let p = &shot.pixels[row + sx as usize * 4..row + sx as usize * 4 + 4];
                    for (total, value) in sum.iter_mut().zip(p) {
                        *total += *value as u32;
                    }
                }
            }
            let count = (y1 - y0) * (x1 - x0);
            rgba.extend_from_slice(&[
                (sum[2] / count) as u8,
                (sum[1] / count) as u8,
                (sum[0] / count) as u8,
                (sum[3] / count) as u8,
            ]);
        }
    }
    let mut data = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut data, out_width, out_height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder
            .write_header()
            .map_err(|e| crate::error::DriverError {
                code: "capture_failed",
                message: e.to_string(),
            })?;
        writer
            .write_image_data(&rgba)
            .map_err(|e| crate::error::DriverError {
                code: "capture_failed",
                message: e.to_string(),
            })?;
    }
    Ok(Picture {
        data: base64(&data),
        width: out_width,
        height: out_height,
    })
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}
