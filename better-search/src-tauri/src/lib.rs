use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_log::log;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

mod docx;
mod recent;
mod settings;
mod web_search;
use settings::SettingsState;

/// The Go sidecar. It runs for as long as the app does: while every window is
/// hidden it's told to give its memory back (`trim_backend`) rather than
/// stopped, so Alt+S searches at once instead of waiting for it to start and
/// open the index. Restarted on the next show if it ever exits.
#[derive(Default)]
struct Backend(Mutex<Option<CommandChild>>);

fn start_backend(app: &AppHandle) {
    let state = app.state::<Backend>();
    let mut current = state.0.lock().unwrap();
    if current.is_some() {
        return;
    }

    // The indexer reads the user's exclusions from settings.json.
    let spawned = app
        .shell()
        .sidecar("better-search-helper")
        .map(|cmd| match settings::path(app) {
            Some(path) => cmd.arg("-settings").arg(path),
            None => cmd,
        })
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

/// The Go watcher: keeps the index current from filesystem changes. Unlike the
/// search sidecar it runs for as long as the app does; Windows hands it each
/// change, so it uses no CPU between them.
#[derive(Default)]
struct Watcher(Mutex<Option<CommandChild>>);

fn start_watcher(app: &AppHandle) {
    let state = app.state::<Watcher>();
    let mut current = state.0.lock().unwrap();
    if current.is_some() {
        return;
    }

    let spawned = app
        .shell()
        .sidecar("better-search-watcher")
        .map(|cmd| match settings::path(app) {
            Some(path) => cmd.arg("-settings").arg(path),
            None => cmd,
        })
        .and_then(|cmd| cmd.spawn());
    let (mut rx, child) = match spawned {
        Ok(v) => v,
        Err(e) => {
            log::error!("Failed to start watcher: {e}");
            return;
        }
    };
    let pid = child.pid();
    *current = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    log::info!("[watcher] {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Terminated(status) => {
                    let state = app.state::<Watcher>();
                    let mut current = state.0.lock().unwrap();
                    if current.as_ref().map(|c| c.pid()) == Some(pid) {
                        *current = None;
                        log::warn!("Watcher exited: {status:?}");
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

fn stop_watcher(app: &AppHandle) {
    let child = app.state::<Watcher>().0.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

/// The app's windows are all hidden: the backend frees its caches and pages
/// out until the next request, sitting at a few MB.
fn trim_backend(app: &AppHandle) {
    if let Some(child) = app.state::<Backend>().0.lock().unwrap().as_mut() {
        let _ = child.write(b"{\"type\":\"trim\"}\n");
    }
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
        // Not in `tauri dev`: a suspended page can't take Vite's updates, so
        // they pile up and run as a full reload the moment Alt+S resumes it,
        // and that reload stalls before the app mounts (a blank window).
        if !cfg!(debug_assertions) {
            set_webview_suspended(&controller, low);
        }
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

/// Where the search bar sits, in physical pixels, as the page reports with
/// every `resize_window`.
#[derive(Default)]
struct BarLayout(Mutex<BarLayoutInner>);

#[derive(Default)]
struct BarLayoutInner {
    /// How far down the window the bar is: the frame's padding, plus the
    /// preview above the bar while one is shown.
    top: i32,
    /// How far down the screen the bar goes, which the page works out so the
    /// bar, the preview above it and the results below look centred. None
    /// until the page has loaded.
    screen_top: Option<i32>,
}

/// Centres the window horizontally on the monitor the mouse is on, with the
/// search bar as far down as the page asked (see `BarLayoutInner`), so
/// results grow downwards and the preview upwards. The window is only as big
/// as its content (the page sizes it, see `resize_window`), which keeps
/// WebView2's drawing buffers small.
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
    let state = window.state::<BarLayout>();
    let bar = state.0.lock().unwrap();
    let bar_y = bar.screen_top.unwrap_or(area.height as i32 / 3);
    // The page centres between the taskbar and the screen's other edge.
    let work_top = monitor.work_area().position.y;
    let _ = window.set_position(tauri::PhysicalPosition::new(
        origin.x + (area.width as i32 - size.width as i32) / 2,
        work_top + bar_y - bar.top,
    ));
}

/// Moves and resizes in one step: done as two, the window would show for a
/// frame with the bar out of place when the preview appears above it.
#[cfg(windows)]
fn set_bounds(window: &WebviewWindow, x: i32, y: i32, width: u32, height: u32) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd.0 as _),
            None,
            x,
            y,
            width as i32,
            height as i32,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(windows))]
fn set_bounds(window: &WebviewWindow, x: i32, y: i32, width: u32, height: u32) {
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = window.set_size(tauri::PhysicalSize::new(width, height));
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
    // The settings and first-run windows show the index and can rebuild it.
    let app = window.app_handle();
    if app.get_webview_window(SETTINGS_LABEL).is_none() && app.get_webview_window(ONBOARDING_LABEL).is_none() {
        went_idle(app);
    }
    set_webview_low_memory(window, true);
}

fn toggle_search(app: &AppHandle) {
    match app.get_webview_window(SEARCH_LABEL) {
        Some(window) if window.is_visible().unwrap_or(false) => hide_search(&window),
        _ => open_search(app),
    }
}

/// The settings window is an ordinary one: built when opened and destroyed
/// when closed (see `run`), as it's rarely open. The page tells it apart from
/// the search by its label.
const SETTINGS_LABEL: &str = "settings";

/// A small undecorated window of the app's own pages (settings, the first-run
/// screen): the same page as the search, told apart by its label.
fn build_panel(app: &AppHandle, label: &str, title: &str, width: f64, height: f64) -> tauri::Result<WebviewWindow> {
    // WebView2 shares one browser process between the windows, which only
    // works if they're started with the same arguments.
    let browser_args = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == SEARCH_LABEL)
        .and_then(|w| w.additional_browser_args.clone());
    let mut builder = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(width, height)
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .center();
    if let Some(args) = browser_args {
        builder = builder.additional_browser_args(&args);
    }
    builder.build()
}

/// Async, as building a webview from a command on the main thread deadlocks.
#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    start_backend(&app);
    let scale = app.state::<SettingsState>().0.lock().unwrap().ui_scale;
    let window = build_panel(
        &app,
        SETTINGS_LABEL,
        "Better Search settings",
        SETTINGS_SIZE.0 * scale,
        SETTINGS_SIZE.1 * scale,
    )
    .map_err(|e| e.to_string())?;
    let _ = window.set_zoom(scale);
    Ok(())
}

/// The settings window at 100%: 880x560 of page, plus the 24px each side its
/// shadow is drawn in. Scaled by `Settings::ui_scale`, like its page.
const SETTINGS_SIZE: (f64, f64) = (928.0, 608.0);

/// Zooms the settings page to the interface size and resizes its window to
/// match, keeping it centred where it was. The search window zooms itself.
pub fn scale_settings_window(app: &AppHandle, scale: f64) {
    let Some(window) = app.get_webview_window(SETTINGS_LABEL) else { return };
    let _ = window.set_zoom(scale);
    let Ok(factor) = window.scale_factor() else { return };
    let width = (SETTINGS_SIZE.0 * scale * factor).round() as u32;
    let height = (SETTINGS_SIZE.1 * scale * factor).round() as u32;
    match (window.outer_position(), window.outer_size()) {
        (Ok(pos), Ok(old)) => set_bounds(
            &window,
            pos.x + (old.width as i32 - width as i32) / 2,
            pos.y + (old.height as i32 - height as i32) / 2,
            width,
            height,
        ),
        _ => {
            let _ = window.set_size(tauri::PhysicalSize::new(width, height));
        }
    }
}

/// The first-run screen: asks for administrator rights, builds the first
/// index and says when it's done. Opened on start until the user has been
/// through it (`Settings::onboarded`).
const ONBOARDING_LABEL: &str = "onboarding";

fn open_onboarding(app: &AppHandle) {
    if app.get_webview_window(ONBOARDING_LABEL).is_some() {
        return;
    }
    start_backend(app);
    // Building a webview waits on the main thread, so do it from another task.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = build_panel(&app, ONBOARDING_LABEL, "Welcome to Better Search", 560.0, 460.0) {
            log::error!("Failed to open the first-run screen: {e}");
        }
    });
}

/// Quits for good; otherwise the app keeps running in the background.
#[tauri::command]
fn quit_app(app: AppHandle) {
    stop_backend(&app);
    stop_watcher(&app);
    app.exit(0);
}

#[tauri::command]
fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Fits the window to the page's content. Sizes are physical pixels: the
/// page's CSS pixels don't match Tauri's logical ones when Windows text
/// scaling zooms the webview. Keeps the window centred horizontally and the
/// search bar where it is (`bar_top` is its offset in the window), so
/// results grow downwards and the preview upwards. `bar_screen_top` is where
/// `place_search` puts the bar the next time the search opens; `recenter`
/// puts it there now, for a new zoom that changes the whole layout.
#[tauri::command]
fn resize_window(window: WebviewWindow, width: u32, height: u32, bar_top: i32, bar_screen_top: i32, recenter: bool) {
    let state = window.state::<BarLayout>();
    let mut bar = state.0.lock().unwrap();
    let monitor = window.current_monitor().ok().flatten().filter(|_| recenter);
    match (window.outer_position(), window.outer_size(), monitor) {
        (_, _, Some(monitor)) => {
            let (area, origin) = (monitor.size(), monitor.position());
            let x = origin.x + (area.width as i32 - width as i32) / 2;
            let y = monitor.work_area().position.y + bar_screen_top - bar_top;
            set_bounds(&window, x, y, width, height);
        }
        (Ok(pos), Ok(old), None) => {
            let x = pos.x + (old.width as i32 - width as i32) / 2;
            let y = pos.y + bar.top - bar_top;
            set_bounds(&window, x, y, width, height);
        }
        _ => {
            let _ = window.set_size(tauri::PhysicalSize::new(width, height));
        }
    }
    bar.top = bar_top;
    bar.screen_top = Some(bar_screen_top);
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
        went_idle(window.app_handle());
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
/// is None. Only web pages (a search provider's results can be plain http),
/// and only browsers from `installed_browsers`: the page builds both from the
/// user's input, nothing else should reach the shell.
#[tauri::command]
fn open_url(app: AppHandle, url: String, browser: Option<String>) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only web pages can be opened".into());
    }
    let Some(id) = browser.filter(|id| id != "default") else {
        return app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string());
    };
    let chosen = installed_browsers()
        .into_iter()
        .find(|b| b.id == id)
        .ok_or_else(|| format!("browser not installed: {id}"))?;
    // The browser's own logging (Firefox prints its startup errors) shouldn't
    // land in this app's console.
    std::process::Command::new(&chosen.exe)
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
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
    app_processes().into_iter().map(private_working_set).sum()
}

/// This process and every descendant (the WebView2 processes and the
/// sidecars), from one snapshot of the system's process list: just ids and
/// parents, where a full process listing reads every process's details.
#[cfg(windows)]
fn app_processes() -> Vec<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let mut family = vec![std::process::id()];
    let mut links = Vec::new(); // (process, parent)
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return family;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            links.push((entry.th32ProcessID, entry.th32ParentProcessID));
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    let mut i = 0;
    while i < family.len() {
        let pid = family[i];
        i += 1;
        for &(child, parent) in &links {
            if parent == pid && !family.contains(&child) {
                family.push(child);
            }
        }
    }
    family
}

/// Moves the app's pages out of RAM while all its windows are hidden: the
/// shell's leftovers from making icons and previews, and the suspended
/// WebView2 processes, which Windows would otherwise only trim minutes
/// later. They stay in memory on Windows' standby list, so the next Alt+S
/// gets them back without reading the disk.
#[cfg(windows)]
fn trim_app_memory() {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA};

    for pid in app_processes() {
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, false, pid) {
                let _ = EmptyWorkingSet(handle);
                let _ = CloseHandle(handle);
            }
        }
    }
}

#[cfg(not(windows))]
fn trim_app_memory() {}

/// Every window is hidden: the backend frees its caches, and once the hidden
/// webview has had a moment to suspend, the app's memory is trimmed. Skipped
/// if a window came back in the meantime.
fn went_idle(app: &AppHandle) {
    trim_backend(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        if !app.webview_windows().values().any(|w| w.is_visible().unwrap_or(false)) {
            trim_app_memory();
        }
    });
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

/// Images go to the page as the file's raw bytes, no bytes meaning none:
/// a third smaller than base64 data URLs, and the page keeps them as blobs
/// rather than strings (see image-cache.ts).
fn image_response(image: Option<Vec<u8>>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(image.unwrap_or_default())
}

/// The Explorer icon for a path as a PNG. Runs off the main thread: the shell
/// may touch the disk.
#[cfg(windows)]
#[tauri::command]
async fn file_icon(path: String) -> tauri::ipc::Response {
    image_response(
        tauri::async_runtime::spawn_blocking(move || shell_icon_png(&path))
            .await
            .ok()
            .flatten(),
    )
}

#[cfg(windows)]
fn shell_icon_png(path: &str) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::DeleteObject;
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
        let mut png = None;
        if GetIconInfo(info.hIcon, &mut icon).is_ok() {
            png = encode_bitmap(icon.hbmColor, false);
            let _ = DeleteObject(icon.hbmColor.into());
            let _ = DeleteObject(icon.hbmMask.into());
        }
        let _ = DestroyIcon(info.hIcon);
        png
    }
}

/// Explorer's thumbnail for a file (photos, video frames, PDF and Office
/// pages, ...) as a JPEG or PNG, fitted within `size` × `size` physical
/// pixels. None if Windows has no thumbnail for it, only an icon.
#[cfg(windows)]
#[tauri::command]
async fn file_thumbnail(path: String, size: u32) -> tauri::ipc::Response {
    image_response(
        tauri::async_runtime::spawn_blocking(move || {
            let size = size.clamp(16, 1024);
            shell_thumbnail(&path, size).or_else(|| {
                // Without Acrobat or a similar app, Windows has no PDF thumbnails.
                path.to_lowercase().ends_with(".pdf").then(|| pdf_first_page(&path, size)).flatten()
            })
        })
        .await
        .ok()
        .flatten(),
    )
}

#[cfg(windows)]
fn shell_thumbnail(path: &str, size: u32) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::DeleteObject;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_THUMBNAILONLY};

    unsafe {
        // Thumbnail providers are COM objects; this is a blocking-pool thread.
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let image = SHCreateItemFromParsingName::<_, _, IShellItemImageFactory>(PCWSTR(wide.as_ptr()), None)
            .and_then(|factory| {
                let side = size as i32;
                factory.GetImage(SIZE { cx: side, cy: side }, SIIGBF_THUMBNAILONLY)
            })
            .ok()
            .and_then(|bitmap| {
                let image = encode_bitmap(bitmap, true);
                let _ = DeleteObject(bitmap.into());
                image
            });
        if com {
            CoUninitialize();
        }
        image
    }
}

/// A PDF's first page as a PNG, fitted within `size` × `size` physical
/// pixels, rendered by Windows' own PDF engine (Edge's). None for
/// password-protected or broken files.
#[cfg(windows)]
fn pdf_first_page(path: &str, size: u32) -> Option<Vec<u8>> {
    use windows::core::HSTRING;
    use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
    use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};
    use windows::Storage::StorageFile;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    let render = || -> windows::core::Result<Vec<u8>> {
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.join()?;
        let page = PdfDocument::LoadFromFileAsync(&file)?.join()?.GetPage(0)?;
        let page_size = page.Size()?;
        let scale = size as f32 / page_size.Width.max(page_size.Height).max(1.0);
        let options = PdfPageRenderOptions::new()?;
        options.SetDestinationWidth((page_size.Width * scale).round().max(1.0) as u32)?;
        options.SetDestinationHeight((page_size.Height * scale).round().max(1.0) as u32)?;
        let stream = InMemoryRandomAccessStream::new()?;
        page.RenderWithOptionsToStreamAsync(&stream, &options)?.join()?;
        let len = stream.Size()? as u32;
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        reader.LoadAsync(len)?.join()?;
        let mut png = vec![0u8; len as usize];
        reader.ReadBytes(&mut png)?;
        Ok(png)
    };

    unsafe {
        // Multithreaded: waiting on the render (`join`) would block a
        // single-threaded apartment's message loop. Each thumbnail call
        // uninitializes, so this thread has no apartment yet.
        let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let png = render();
        if com {
            CoUninitialize();
        }
        png.ok().filter(|png| !png.is_empty())
    }
}

/// A 32-bit bitmap encoded as a PNG, or with `jpeg_if_opaque` a JPEG when it
/// has no transparency (photos are several times smaller as JPEG). The caller
/// still owns `bitmap`.
#[cfg(windows)]
unsafe fn encode_bitmap(bitmap: windows::Win32::Graphics::Gdi::HBITMAP, jpeg_if_opaque: bool) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS,
    };

    let mut bmp = BITMAP::default();
    GetObjectW(
        bitmap.into(),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bmp as *mut _ as *mut _),
    );
    let (w, h) = (bmp.bmWidth, bmp.bmHeight);
    if w <= 0 || h <= 0 {
        return None;
    }
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
        bitmap,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut _),
        &mut header as *mut _ as *mut BITMAPINFO,
        DIB_RGB_COLORS,
    );
    let _ = DeleteDC(dc);
    if lines == 0 {
        return None;
    }
    // BGRA -> RGBA. Bitmaps without an alpha channel come back all zero
    // there, so make those opaque.
    let opaque = buf.chunks_exact(4).all(|px| px[3] == 0);
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
        if opaque {
            px[3] = 255;
        }
    }

    let mut out = Vec::new();
    if jpeg_if_opaque && buf.chunks_exact(4).all(|px| px[3] == 255) {
        jpeg_encoder::Encoder::new(&mut out, 85)
            .encode(&buf, w.try_into().ok()?, h.try_into().ok()?, jpeg_encoder::ColorType::Rgba)
            .ok()?;
        return Some(out);
    }
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(&buf).ok()?;
    }
    Some(out)
}

#[cfg(not(windows))]
#[tauri::command]
async fn file_thumbnail(_path: String, _size: u32) -> tauri::ipc::Response {
    image_response(None)
}

/// The preview shows a screenful of text; this is plenty for that.
const TEXT_PREVIEW_BYTES: u64 = 8 * 1024;

/// The start of a text file, for the preview. None for binary files (any
/// NUL byte, outside UTF-16) or files that can't be read.
#[tauri::command]
async fn text_preview(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        std::fs::File::open(&path)
            .ok()?
            .take(TEXT_PREVIEW_BYTES)
            .read_to_end(&mut buf)
            .ok()?;

        // Notepad and PowerShell write UTF-16 with a byte-order mark.
        if let Some(rest) = buf.strip_prefix(b"\xFF\xFE") {
            let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            return Some(String::from_utf16_lossy(&units));
        }
        if buf.contains(&0) {
            return None;
        }
        let text = buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&buf);
        // The cut may land inside a character.
        Some(String::from_utf8_lossy(text).trim_end_matches('\u{FFFD}').to_string())
    })
    .await
    .ok()
    .flatten()
}

#[derive(serde::Serialize)]
struct FolderEntry {
    name: String,
    dir: bool,
}

#[derive(serde::Serialize)]
struct FolderPreview {
    /// Folders first, then by name; at most `FOLDER_PREVIEW_ENTRIES`.
    entries: Vec<FolderEntry>,
    /// Visible entries counted, up to `FOLDER_SCAN_LIMIT`.
    total: usize,
    /// The folder holds more than `total`.
    more: bool,
}

const FOLDER_PREVIEW_ENTRIES: usize = 30;
/// Stops a huge folder (System32, node_modules) from stalling the preview.
const FOLDER_SCAN_LIMIT: usize = 1000;

/// A folder's contents for the preview, skipping hidden and system entries
/// as Explorer does by default.
#[tauri::command]
async fn folder_preview(path: String) -> Option<FolderPreview> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::new();
        let mut more = false;
        for entry in std::fs::read_dir(&path).ok()?.flatten() {
            if entries.len() == FOLDER_SCAN_LIMIT {
                more = true;
                break;
            }
            let Ok(meta) = entry.metadata() else { continue };
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
                if meta.file_attributes() & HIDDEN_OR_SYSTEM != 0 {
                    continue;
                }
            }
            entries.push(FolderEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                dir: meta.is_dir(),
            });
        }
        let total = entries.len();
        entries.sort_by_cached_key(|e| (!e.dir, e.name.to_lowercase()));
        entries.truncate(FOLDER_PREVIEW_ENTRIES);
        Some(FolderPreview { entries, total, more })
    })
    .await
    .ok()
    .flatten()
}

#[cfg(not(windows))]
#[tauri::command]
async fn file_icon(_path: String) -> tauri::ipc::Response {
    image_response(None)
}

#[cfg(not(windows))]
#[tauri::command]
fn memory_usage() -> u64 {
    0
}

/// Whether this build can update itself: the updater needs its signing key
/// and update address in tauri.conf.json ("plugins" > "updater").
fn updates_configured(config: &tauri::Config) -> bool {
    config.plugins.0.contains_key("updater")
}

/// For the About page, which says so when this build can't update.
#[tauri::command]
fn can_update(app: AppHandle) -> bool {
    updates_configured(app.config())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let builder = tauri::Builder::default();
    // Without its config the updater stops the app from starting, so a build
    // without it just doesn't update.
    let builder = if updates_configured(context.config()) {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    builder
        .manage(Backend::default())
        .manage(Watcher::default())
        .manage(BarLayout::default())
        // The app is named "Better Search" (productName, which Task Manager
        // shows); its login entry and log file keep the names they had.
        .plugin(tauri_plugin_autostart::Builder::new().app_name("better-search").build())
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("better-search".into()),
                    }),
                ])
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            resize_window,
            hide_window,
            search_ready,
            backend_send,
            open_result,
            open_url,
            list_browsers,
            file_icon,
            file_thumbnail,
            text_preview,
            folder_preview,
            docx::docx_preview,
            memory_usage,
            open_settings,
            quit_app,
            open_logs_folder,
            can_update,
            settings::get_settings,
            settings::update_settings,
            settings::pause_shortcut,
            settings::list_drives,
            settings::storage_usage,
            web_search::api_keys,
            web_search::save_api_key,
            web_search::remove_api_key,
            web_search::web_search,
            web_search::favicon,
            web_search::api_usage,
            recent::recent_searches,
            recent::add_recent_search,
            recent::clear_recent_searches
        ])
        .setup(|app| {
            // No window until the first Alt+S ("create": false in tauri.conf.json).
            let saved = settings::load(app.handle());
            if let Err(e) = settings::register_shortcut(app.handle(), &saved.shortcut) {
                log::error!("{e} Falling back to {}.", settings::DEFAULT_SHORTCUT);
                settings::register_shortcut(app.handle(), settings::DEFAULT_SHORTCUT)?;
            }
            let first_run = !saved.onboarded;
            app.manage(SettingsState(Mutex::new(saved)));
            if first_run {
                open_onboarding(app.handle());
            }
            start_watcher(app.handle());
            start_backend(app.handle());

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
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Destroying the search window closes the last window, which would
            // quit the app; keep running in the background for Alt+S.
            tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            // Really quitting (an update, a restart): don't leave the sidecars behind.
            tauri::RunEvent::Exit => {
                stop_backend(app);
                stop_watcher(app);
            }
            // Settings or the first-run screen closed: with nothing else
            // shown, the backend can give its memory back.
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. }
                if label == SETTINGS_LABEL || label == ONBOARDING_LABEL =>
            {
                let busy = |l: &str| app.get_webview_window(l).is_some_and(|w| w.is_visible().unwrap_or(false));
                if !busy(SEARCH_LABEL) && !busy(SETTINGS_LABEL) && !busy(ONBOARDING_LABEL) {
                    went_idle(app);
                }
            }
            _ => {}
        });
}
