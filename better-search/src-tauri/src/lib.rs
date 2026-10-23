use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_log::log;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// The Go sidecar. It only runs while the search window is open; hiding the
/// window stops it so the app sits idle in the background.
#[derive(Default)]
struct Backend(Mutex<Option<CommandChild>>);

fn start_backend(app: &AppHandle) {
    let state = app.state::<Backend>();
    let mut current = state.0.lock().unwrap();
    if current.is_some() {
        return;
    }

    let spawned = app
        .shell()
        .sidecar("better-search-backend")
        .and_then(|cmd| cmd.spawn());
    let (mut rx, child) = match spawned {
        Ok(v) => v,
        Err(e) => {
            log::error!("Failed to start backend: {e}");
            return;
        }
    };
    let pid = child.pid();
    *current = Some(child);

    // Forward each stdout line (one JSON message) to the frontend.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).trim_end().to_string();
                    if !line.is_empty() {
                        let _ = app.emit("backend-message", line);
                    }
                }
                CommandEvent::Stderr(line) => {
                    log::info!("[backend] {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Terminated(status) => {
                    // Only report it if it died on its own, not because we stopped it.
                    let state = app.state::<Backend>();
                    let mut current = state.0.lock().unwrap();
                    if current.as_ref().map(|c| c.pid()) == Some(pid) {
                        *current = None;
                        log::error!("Backend exited unexpectedly: {status:?}");
                        let _ = app.emit("backend-stopped", ());
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

fn stop_backend(app: &AppHandle) {
    let child = app.state::<Backend>().0.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
        let _ = app.emit("backend-stopped", ());
    }
}

/// While hidden, ask WebView2 to give memory back (it discards caches and lets
/// Windows page out the rest) and suspend the page; restore normal behaviour
/// before showing again. Hidden and suspended, it settles at ~10-20 MB.
#[cfg(windows)]
fn set_webview_low_memory(window: &WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = window.with_webview(move |webview| unsafe {
        let controller = webview.controller();
        let result = controller
            .CoreWebView2()
            .and_then(|core| core.cast::<ICoreWebView2_19>())
            .and_then(|core| core.SetMemoryUsageTargetLevel(level));
        if let Err(e) = result {
            log::warn!("Failed to set WebView memory level: {e}");
        }
        set_webview_suspended(&controller, low);
    });
}

/// Suspending stops the hidden page's script and rendering, letting WebView2
/// free more than the low memory level alone. It only works on a WebView
/// marked invisible, and must be resumed before it's shown again.
#[cfg(windows)]
unsafe fn set_webview_suspended(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    suspended: bool,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
    use webview2_com::TrySuspendCompletedHandler;
    use windows_core::Interface;

    let core = match controller.CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_3>()) {
        Ok(core) => core,
        Err(e) => return log::warn!("WebView suspend unsupported: {e}"),
    };
    let result = if suspended {
        controller.SetIsVisible(false).and_then(|_| {
            core.TrySuspend(&TrySuspendCompletedHandler::create(Box::new(|err, ok| {
                if err.is_err() || !ok {
                    log::warn!("WebView did not suspend: {err:?}");
                }
                Ok(())
            })))
        })
    } else {
        core.Resume().and_then(|_| controller.SetIsVisible(true))
    };
    if let Err(e) = result {
        log::warn!("Failed to {} WebView: {e}", if suspended { "suspend" } else { "resume" });
    }
}

#[cfg(not(windows))]
fn set_webview_low_memory(_window: &WebviewWindow, _low: bool) {}

/// Centres the window horizontally a quarter of the way down the monitor
/// the mouse is on, so results have room to grow downwards. The window is
/// only as big as the search box (the page sizes it, see `resize_window`),
/// which keeps WebView2's drawing buffers small.
fn place_search(window: &WebviewWindow) {
    let monitor = window
        .cursor_position()
        .ok()
        .and_then(|p| window.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let (Some(monitor), Ok(size)) = (monitor, window.outer_size()) else {
        return;
    };

    let area = monitor.size();
    let origin = monitor.position();
    let _ = window.set_position(tauri::PhysicalPosition::new(
        origin.x + (area.width as i32 - size.width as i32) / 2,
        origin.y + area.height as i32 / 4,
    ));
}

fn show_search(window: &WebviewWindow) {
    set_webview_low_memory(window, false);
    start_backend(window.app_handle());

    place_search(window);
    let _ = window.show();
    let _ = window.set_focus();
    // Tells the page to refresh its state. Focus events aren't reliable for
    // this: the webview often still counts as focused from last time.
    let _ = window.app_handle().emit("search-shown", ());
}

/// Dismissing the search only hides the window, which is never destroyed, so
/// Alt+S always reopens it instantly. Building it again would take WebView2
/// ~0.5 s or more, to save only ~5-15 MB over the hidden, suspended window.
const SEARCH_LABEL: &str = "better-search";

/// Builds the search window from its tauri.conf.json entry ("create": false:
/// `setup` builds it instead, in the background).
fn create_search_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == SEARCH_LABEL)
        .cloned()
        .expect("search window missing from tauri.conf.json");
    tauri::WebviewWindowBuilder::from_config(app, &config)?.build()
}

fn open_search(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SEARCH_LABEL) {
        show_search(&window);
        return;
    }
    // Building a webview waits on the main thread, which is where shortcut
    // callbacks run, so build it from another task.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match create_search_window(&app) {
            Ok(window) => show_search(&window),
            Err(e) => log::error!("Failed to create search window: {e}"),
        }
    });
}

fn hide_search(window: &WebviewWindow) {
    let _ = window.hide();
    stop_backend(window.app_handle());
    set_webview_low_memory(window, true);
}

fn toggle_search(app: &AppHandle) {
    match app.get_webview_window(SEARCH_LABEL) {
        Some(window) if window.is_visible().unwrap_or(false) => hide_search(&window),
        _ => open_search(app),
    }
}

/// Fits the window to the page's content. Sizes are physical pixels: the
/// page's CSS pixels don't match Tauri's logical ones when Windows text
/// scaling zooms the webview. Keeps the window centred horizontally and its
/// top edge fixed, so results grow downwards.
#[tauri::command]
fn resize_window(window: WebviewWindow, width: u32, height: u32) {
    if let (Ok(pos), Ok(old)) = (window.outer_position(), window.outer_size()) {
        if old.width != width {
            let x = pos.x + (old.width as i32 - width as i32) / 2;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, pos.y));
        }
    }
    let _ = window.set_size(tauri::PhysicalSize::new(width, height));
}

#[tauri::command]
fn hide_window(window: WebviewWindow) {
    hide_search(&window);
}

/// The page calls this once it has loaded and mounted. Only then is the
/// hidden, pre-built window trimmed and suspended: suspending on a timer
/// could freeze a page still loading (Vite's first, cold load in `tauri dev`
/// takes several seconds), leaving the first Alt+S to wait for the rest.
#[tauri::command]
fn search_ready(window: WebviewWindow) {
    if !window.is_visible().unwrap_or(true) {
        set_webview_low_memory(&window, true);
    }
}

/// Writes one JSON request line to the backend's stdin.
#[tauri::command]
fn backend_send(app: AppHandle, message: String) -> Result<(), String> {
    let state = app.state::<Backend>();
    let mut current = state.0.lock().unwrap();
    let child = current.as_mut().ok_or("backend is not running")?;
    child
        .write(format!("{message}\n").as_bytes())
        .map_err(|e| e.to_string())
}

/// Opens a search result with its default app, or shows it in Explorer.
#[tauri::command]
fn open_result(app: AppHandle, path: String, reveal: bool) -> Result<(), String> {
    let opener = app.opener();
    if reveal {
        opener.reveal_item_in_dir(&path)
    } else {
        opener.open_path(&path, None::<&str>)
    }
    .map_err(|e| e.to_string())
}

/// A browser installed on this machine, as registered with Windows.
#[derive(serde::Serialize)]
struct Browser {
    /// The registration's key name under `Clients\StartMenuInternet`.
    id: String,
    name: String,
    /// The browser's program, which the page asks `file_icon` for the icon of.
    /// Display only: `open_url` looks the program up again from the id.
    exe: String,
}

/// Browsers registered under `Clients\StartMenuInternet`, the list Windows'
/// own "Default apps" page is built from.
#[cfg(windows)]
fn installed_browsers() -> Vec<Browser> {
    use winreg::{enums::*, RegKey};

    const CLIENTS: &str = r"SOFTWARE\Clients\StartMenuInternet";
    let mut found: Vec<Browser> = Vec::new();
    for (hive, path) in [
        (HKEY_LOCAL_MACHINE, CLIENTS.to_string()),
        (HKEY_CURRENT_USER, CLIENTS.to_string()),
        (HKEY_LOCAL_MACHINE, CLIENTS.replace("SOFTWARE", r"SOFTWARE\WOW6432Node")),
    ] {
        let Ok(clients) = RegKey::predef(hive).open_subkey(path) else { continue };
        for id in clients.enum_keys().flatten() {
            if found.iter().any(|b| b.id == id) || id.eq_ignore_ascii_case("IEXPLORE.EXE") {
                continue;
            }
            let Ok(key) = clients.open_subkey(&id) else { continue };
            let Ok(command) = key
                .open_subkey(r"shell\open\command")
                .and_then(|k| k.get_value::<String, _>(""))
            else {
                continue;
            };
            let Some(exe) = exe_of_command(&command).filter(|p| std::path::Path::new(p).is_file()) else {
                continue;
            };
            let name = key.get_value::<String, _>("").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| id.clone());
            found.push(Browser { id, name, exe });
        }
    }
    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found
}

#[cfg(not(windows))]
fn installed_browsers() -> Vec<Browser> {
    Vec::new()
}

/// The program in a registered command line: `"C:\a b\x.exe" -arg` or
/// `C:\a\x.exe -arg`.
#[cfg(windows)]
fn exe_of_command(command: &str) -> Option<String> {
    let command = command.trim();
    if let Some(rest) = command.strip_prefix('"') {
        return rest.split('"').next().map(str::to_string);
    }
    let end = command.to_lowercase().find(".exe")? + ".exe".len();
    Some(command[..end].to_string())
}

/// Lists the browsers installed on this machine for the search's browser menu.
#[tauri::command]
fn list_browsers() -> Vec<Browser> {
    installed_browsers()
}

/// Opens a web page in the chosen browser, or the default one when `browser`
/// is None. Only https URLs, and only browsers from `installed_browsers`: the
/// page builds both from the user's input, nothing else should reach the shell.
#[tauri::command]
fn open_url(app: AppHandle, url: String, browser: Option<String>) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https URLs can be opened".into());
    }
    let Some(id) = browser.filter(|id| id != "default") else {
        return app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string());
    };
    let chosen = installed_browsers()
        .into_iter()
        .find(|b| b.id == id)
        .ok_or_else(|| format!("browser not installed: {id}"))?;
    std::process::Command::new(&chosen.exe)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Memory in bytes used by this app: the shell, its WebView2 processes and
/// the backend (every descendant of this process). Counts each process's
/// private working set, like Task Manager's Memory column: plain working
/// sets include the Chromium DLLs every WebView2 process shares, so summing
/// them counts that memory once per process.
#[cfg(windows)]
#[tauri::command]
fn memory_usage() -> u64 {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let me = Pid::from_u32(std::process::id());
    let mut family = vec![me];
    let mut total = 0;
    let mut i = 0;
    while i < family.len() {
        let pid = family[i];
        i += 1;
        total += private_working_set(pid.as_u32());
        for (child, p) in sys.processes() {
            if p.parent() == Some(pid) && !family.contains(child) {
                family.push(*child);
            }
        }
    }
    total
}

/// 0 if the process has exited or can't be opened.
#[cfg(windows)]
fn private_working_set(pid: u32) -> u64 {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return 0;
        };
        let mut counters = PROCESS_MEMORY_COUNTERS_EX2::default();
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
        counters.cb = size;
        let ok = GetProcessMemoryInfo(handle, &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS, size);
        let _ = CloseHandle(handle);
        if ok.is_ok() {
            counters.PrivateWorkingSetSize as u64
        } else {
            0
        }
    }
}

/// The Explorer icon for a path as a `data:image/png` URL, or None if Windows
/// has none. Runs off the main thread: the shell may touch the disk.
#[cfg(windows)]
#[tauri::command]
async fn file_icon(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || shell_icon_png(&path))
        .await
        .ok()
        .flatten()
}

#[cfg(windows)]
fn shell_icon_png(path: &str) -> Option<String> {
    use base64::Engine;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    unsafe {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut info = SHFILEINFOW::default();
        let got = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if got == 0 || info.hIcon.is_invalid() {
            return None;
        }

        let mut icon = ICONINFO::default();
        let have_info = GetIconInfo(info.hIcon, &mut icon).is_ok();
        let mut rgba = None;
        if have_info {
            let mut bmp = BITMAP::default();
            GetObjectW(
                icon.hbmColor.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bmp as *mut _ as *mut _),
            );
            let (w, h) = (bmp.bmWidth, bmp.bmHeight);
            if w > 0 && h > 0 {
                let mut header = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                };
                let mut buf = vec![0u8; (w * h * 4) as usize];
                let dc = CreateCompatibleDC(None);
                let lines = GetDIBits(
                    dc,
                    icon.hbmColor,
                    0,
                    h as u32,
                    Some(buf.as_mut_ptr() as *mut _),
                    &mut header as *mut _ as *mut BITMAPINFO,
                    DIB_RGB_COLORS,
                );
                let _ = DeleteDC(dc);
                if lines != 0 {
                    // BGRA -> RGBA. Icons without an alpha channel come back
                    // all zero there, so make those opaque.
                    let opaque = buf.chunks_exact(4).all(|px| px[3] == 0);
                    for px in buf.chunks_exact_mut(4) {
                        px.swap(0, 2);
                        if opaque {
                            px[3] = 255;
                        }
                    }
                    rgba = Some((w as u32, h as u32, buf));
                }
            }
            let _ = DeleteObject(icon.hbmColor.into());
            let _ = DeleteObject(icon.hbmMask.into());
        }
        let _ = DestroyIcon(info.hIcon);

        let (w, h, buf) = rgba?;
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header().ok()?.write_image_data(&buf).ok()?;
        }
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(out)
        ))
    }
}

#[cfg(not(windows))]
#[tauri::command]
async fn file_icon(_path: String) -> Option<String> {
    None
}

#[cfg(not(windows))]
#[tauri::command]
fn memory_usage() -> u64 {
    0
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Backend::default())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            resize_window,
            hide_window,
            search_ready,
            backend_send,
            open_result,
            open_url,
            list_browsers,
            file_icon,
            memory_usage
        ])
        .setup(|app| {
            // No window until the first Alt+S ("create": false in tauri.conf.json).
            let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyS);

            app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_search(app);
                }
            })?;

            // Build the window now, hidden, so the first Alt+S only has to
            // show it instead of waiting on WebView2 to start. The page
            // calls `search_ready` once loaded, which suspends it.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = create_search_window(&handle) {
                    log::error!("Failed to pre-create search window: {e}");
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Destroying the search window closes the last window, which would
            // quit the app; keep running in the background for Alt+S.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
