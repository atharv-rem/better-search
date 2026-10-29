//! Snap mode (Alt+W): the search window lists the open windows, and the user
//! picks a layout and a window for each of its zones. Typing also finds the
//! installed apps (the Start menu's) and the indexed files: one picked for a
//! zone is launched or opened when the layout is applied, and its window goes
//! there. Windows are placed
//! on the monitor the search opened on, filling its work area (the screen
//! without the taskbar).

#[cfg(windows)]
use std::time::{Duration, Instant};

use tauri::WebviewWindow;
use tauri_plugin_log::log;

/// How long a launched app gets to show its window.
#[cfg(windows)]
const LAUNCH_TIME_LIMIT: Duration = Duration::from_secs(15);

/// How long a launched app's window is kept in its zone after it's placed.
#[cfg(windows)]
const SETTLE_TIME: Duration = Duration::from_secs(5);

/// A window as Alt+Tab would list it.
#[derive(serde::Serialize)]
pub struct OpenWindow {
    /// The window's handle. Handles fit in 32 bits, so the page keeps them as
    /// plain numbers.
    id: isize,
    title: String,
    /// The program behind the window, which the page asks `file_icon` for
    /// the icon of. Empty when it can't be read (an elevated app).
    exe: String,
}

/// An app as the Start menu lists it, desktop and Store apps alike.
#[derive(serde::Serialize)]
pub struct InstalledApp {
    /// Its id in the Apps folder: a Store app's AppUserModelID, or a desktop
    /// app's path or AppUserModelID. "shell:AppsFolder\<id>" launches it.
    id: String,
    name: String,
}

/// Where a window goes, as fractions of the work area (0 to 1): an open
/// window (`id`), the window of an app launched for it (`app`, an
/// `InstalledApp` id), or of a file opened for it (`file`, its path).
#[derive(serde::Deserialize)]
pub struct Placement {
    id: Option<isize>,
    app: Option<String>,
    file: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The open windows, most recently used first: the window that was in front
/// before the search opened leads (the search itself is left out).
#[cfg(windows)]
#[tauri::command]
pub fn open_windows() -> Vec<OpenWindow> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> BOOL {
        let found = &mut *(found.0 as *mut Vec<OpenWindow>);
        if let Some(window) = describe(hwnd) {
            found.push(window);
        }
        true.into()
    }

    let mut found: Vec<OpenWindow> = Vec::new();
    // In Z-order, front to back.
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

#[cfg(not(windows))]
#[tauri::command]
pub fn open_windows() -> Vec<OpenWindow> {
    Vec::new()
}

/// The window if Alt+Tab would list it: shown, unowned, not a tool window,
/// not cloaked (on another virtual desktop, or a suspended Store app), with a
/// title, and not one of this app's.
#[cfg(windows)]
unsafe fn describe(hwnd: windows::Win32::Foundation::HWND) -> Option<OpenWindow> {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindow, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
    };

    if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid()) {
        return None;
    }
    if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
        return None;
    }
    let mut cloaked = 0u32;
    let got = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, size_of::<u32>() as u32);
    if got.is_ok() && cloaked != 0 {
        return None;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == std::process::id() {
        return None;
    }
    // The desktop ("Program Manager") has a title but is no app.
    let mut class = [0u16; 64];
    let len = GetClassNameW(hwnd, &mut class) as usize;
    if String::from_utf16_lossy(&class[..len]) == "Progman" {
        return None;
    }
    let mut title = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut title) as usize;
    let title = String::from_utf16_lossy(&title[..len]).trim().to_string();
    if title.is_empty() {
        return None;
    }
    Some(OpenWindow { id: hwnd.0 as isize, title, exe: app_exe(hwnd, pid) })
}

/// The program a window belongs to. Store apps' windows are frames owned by
/// ApplicationFrameHost.exe, with the app's own window inside: that one's
/// program has the app's icon.
#[cfg(windows)]
unsafe fn app_exe(hwnd: windows::Win32::Foundation::HWND, pid: u32) -> String {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetWindowThreadProcessId};

    let exe = process_exe(pid);
    if !exe.to_lowercase().ends_with("\\applicationframehost.exe") {
        return exe;
    }
    /// (the frame's process, the first other process found inside)
    unsafe extern "system" fn find(child: HWND, pids: LPARAM) -> BOOL {
        let pids = &mut *(pids.0 as *mut (u32, u32));
        let mut pid = 0u32;
        GetWindowThreadProcessId(child, Some(&mut pid));
        if pid != pids.0 {
            pids.1 = pid;
            return false.into();
        }
        true.into()
    }
    let mut pids = (pid, 0u32);
    let _ = EnumChildWindows(Some(hwnd), Some(find), LPARAM(&mut pids as *mut _ as isize));
    if pids.1 == 0 {
        exe
    } else {
        process_exe(pids.1)
    }
}

/// A process's program, or "" if it can't be opened (an elevated one).
#[cfg(windows)]
fn process_exe(pid: u32) -> String {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let got = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        if got.is_ok() {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        }
    }
}

/// Hides the search, launches the apps picked for zones and waits for their
/// windows, then moves each window into its zone on the search's monitor,
/// the first placement ending up in front and focused. Windows that have
/// closed meanwhile, and apps that showed no window in time, are skipped.
/// Elevated apps can't be moved by this (non-elevated) one, and stay where
/// they are.
#[cfg(windows)]
#[tauri::command]
pub async fn snap_windows(window: WebviewWindow, placements: Vec<Placement>) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("the search isn't on a monitor")?;
    let area = monitor.work_area();
    let area = (area.position.x as f64, area.position.y as f64, area.size.width as f64, area.size.height as f64);
    crate::hide_search(&window);
    // Launching waits on the apps' windows, off the main thread.
    tauri::async_runtime::spawn_blocking(move || place_all(placements, area))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn place_all(placements: Vec<Placement>, (left, top, width, height): (f64, f64, f64, f64)) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};

    // Each app or file in turn, so each new window can be told apart.
    let mut taken: Vec<isize> = placements.iter().filter_map(|p| p.id).collect();
    let ids: Vec<Option<isize>> = placements
        .iter()
        .map(|p| {
            let opened = match (&p.app, &p.file) {
                (Some(app), _) => Opened::App(app),
                (None, Some(file)) => Opened::File(file),
                (None, None) => return p.id,
            };
            let id = launch(&opened, &taken);
            if id.is_none() {
                log::warn!("{} showed no window to snap", opened.name());
            }
            taken.extend(id);
            id
        })
        .collect();

    // Each window with its rectangle (x, y, width, height), in physical
    // pixels, and whether it was launched for its zone.
    let targets: Vec<(HWND, (i32, i32, i32, i32), bool)> = placements
        .iter()
        .zip(&ids)
        .filter_map(|(p, id)| {
            // Rounded edges, so neighbouring zones meet without a gap.
            let x = (left + p.x * width).round() as i32;
            let y = (top + p.y * height).round() as i32;
            let right = (left + (p.x + p.width) * width).round() as i32;
            let bottom = (top + (p.y + p.height) * height).round() as i32;
            Some((HWND((*id)? as *mut _), (x, y, right - x, bottom - y), p.id.is_none()))
        })
        .collect();

    // Back to front, so the first zone's window ends up on top.
    for &(hwnd, (x, y, w, h), _) in targets.iter().rev() {
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            continue;
        }
        if let Err(e) = unsafe { place(hwnd, x, y, w, h) } {
            log::warn!("Couldn't snap a window: {e}");
        }
    }
    // Allowed: this app had the last input (the Enter that chose the layout).
    if let Some(&(first, ..)) = targets.first() {
        unsafe {
            let _ = SetForegroundWindow(first);
        }
    }

    // A just-launched app often puts its window back how it last was
    // (maximized, or its old size) a moment after showing it: put it back
    // in its zone until it stays there.
    let launched: Vec<_> = targets.into_iter().filter(|t| t.2).collect();
    if launched.is_empty() {
        return;
    }
    let deadline = Instant::now() + SETTLE_TIME;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(150));
        for &(hwnd, (x, y, w, h), _) in &launched {
            if unsafe { IsWindow(Some(hwnd)) }.as_bool() && !unsafe { in_place(hwnd, x, y, w, h) } {
                if let Err(e) = unsafe { place(hwnd, x, y, w, h) } {
                    log::warn!("Couldn't snap a window: {e}");
                }
            }
        }
    }
}

/// Whether the window's visible frame fills the rectangle, give or take a
/// pixel of rounding.
#[cfg(windows)]
unsafe fn in_place(hwnd: windows::Win32::Foundation::HWND, x: i32, y: i32, width: i32, height: i32) -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowArranged, IsZoomed};

    if IsIconic(hwnd).as_bool() || IsZoomed(hwnd).as_bool() || IsWindowArranged(hwnd).as_bool() {
        return false;
    }
    let mut frame = RECT::default();
    let got = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut frame as *mut _ as *mut _, size_of::<RECT>() as u32);
    let near = |a: i32, b: i32| (a - b).abs() <= 2;
    got.is_ok()
        && near(frame.left, x)
        && near(frame.top, y)
        && near(frame.right - frame.left, width)
        && near(frame.bottom - frame.top, height)
}

/// What `launch` starts for a zone.
#[cfg(windows)]
enum Opened<'a> {
    /// An `InstalledApp` id.
    App(&'a str),
    /// A file's path, opened in the app it belongs to.
    File(&'a str),
}

#[cfg(windows)]
impl Opened<'_> {
    fn name(&self) -> &str {
        match self {
            Opened::App(app) => app,
            Opened::File(path) => path,
        }
    }

    /// A file's name without its extension, lower-cased, which the window
    /// showing it usually has in its title ("report - Word", "report.pdf").
    /// None for apps, and for names too short to tell windows apart by.
    fn title_hint(&self) -> Option<String> {
        let Opened::File(path) = self else { return None };
        let stem = std::path::Path::new(path).file_stem()?.to_string_lossy().to_lowercase();
        (stem.chars().count() >= 3).then_some(stem)
    }
}

/// Launches an installed app or opens a file, and gives back its window: the
/// first window that wasn't open before, or, for an app that only brings its
/// open window forward (one that allows a single instance), the window that
/// comes to the front. A file may open as a tab in a window that was in front
/// already (a PDF in Edge): then it's that window once its title names the
/// file. `taken` are windows already given to other zones.
#[cfg(windows)]
fn launch(opened: &Opened, taken: &[isize]) -> Option<isize> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow, SW_SHOWNORMAL};

    let before: Vec<isize> = open_windows().iter().map(|w| w.id).collect();
    let front = unsafe { GetForegroundWindow() }.0 as isize;
    let target = match opened {
        Opened::App(app) => format!("shell:AppsFolder\\{app}"),
        Opened::File(path) => path.to_string(),
    };
    let title_hint = opened.title_hint();
    let target: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let started = unsafe { ShellExecuteW(None, w!("open"), PCWSTR(target.as_ptr()), None, None, SW_SHOWNORMAL) };
    // Anything above 32 is success.
    if started.0 as isize <= 32 {
        log::warn!("Couldn't open {}", opened.name());
        return None;
    }

    let deadline = Instant::now() + LAUNCH_TIME_LIMIT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(150));
        let foreground = unsafe { GetForegroundWindow() }.0 as isize;
        let names_file = |title: &str| title_hint.as_ref().is_some_and(|hint| title.to_lowercase().contains(hint));
        let found = open_windows()
            .into_iter()
            .filter(|w| !taken.contains(&w.id))
            .find(|w| !before.contains(&w.id) || (w.id == foreground && (w.id != front || names_file(&w.title))))
            .map(|w| w.id);
        if let Some(id) = found {
            // A splash screen closes again: wait for the window that stays.
            std::thread::sleep(Duration::from_millis(400));
            if unsafe { IsWindow(Some(HWND(id as *mut _))) }.as_bool() {
                return Some(id);
            }
        }
    }
    None
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn snap_windows(window: WebviewWindow, _placements: Vec<Placement>) -> Result<(), String> {
    crate::hide_search(&window);
    Err("snapping windows needs Windows".into())
}

/// The Start menu's apps, by name. Their uninstallers are left out.
#[cfg(windows)]
#[tauri::command]
pub async fn installed_apps() -> Vec<InstalledApp> {
    tauri::async_runtime::spawn_blocking(|| {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
        unsafe {
            let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let apps = list_apps().unwrap_or_else(|e| {
                log::warn!("Couldn't list the installed apps: {e}");
                Vec::new()
            });
            if com {
                CoUninitialize();
            }
            apps
        }
    })
    .await
    .unwrap_or_default()
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn installed_apps() -> Vec<InstalledApp> {
    Vec::new()
}

/// The Apps folder (shell:AppsFolder), which is what the Start menu lists.
#[cfg(windows)]
unsafe fn list_apps() -> windows::core::Result<Vec<InstalledApp>> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, SHGetKnownFolderItem, KF_FLAG_DEFAULT,
        SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
    };

    let name_of = |item: &IShellItem, kind: SIGDN| -> Option<String> {
        let name = item.GetDisplayName(kind).ok()?;
        let text = name.to_string().ok();
        CoTaskMemFree(Some(name.0 as *const _));
        text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
    };

    let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)?;
    let items: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems)?;
    let mut apps = Vec::new();
    loop {
        let mut item = [None];
        let mut fetched = 0;
        if items.Next(&mut item, Some(&mut fetched)).is_err() || fetched == 0 {
            break;
        }
        let Some(item) = item[0].take() else { break };
        let (Some(name), Some(id)) = (name_of(&item, SIGDN_NORMALDISPLAY), name_of(&item, SIGDN_PARENTRELATIVEPARSING))
        else {
            continue;
        };
        if name.to_lowercase().contains("uninstall") {
            continue;
        }
        apps.push(InstalledApp { id, name });
    }
    apps.sort_by_cached_key(|a| a.name.to_lowercase());
    Ok(apps)
}

/// An installed app's icon, as the image file's bytes (no bytes: none).
#[cfg(windows)]
#[tauri::command]
pub async fn installed_app_icon(id: String) -> tauri::ipc::Response {
    let png = tauri::async_runtime::spawn_blocking(move || unsafe { app_icon_png(&id) }).await.ok().flatten();
    tauri::ipc::Response::new(png.unwrap_or_default())
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn installed_app_icon(_id: String) -> tauri::ipc::Response {
    tauri::ipc::Response::new(Vec::new())
}

#[cfg(windows)]
unsafe fn app_icon_png(id: &str) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::DeleteObject;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY};

    let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
    let path: Vec<u16> = format!("shell:AppsFolder\\{id}").encode_utf16().chain(Some(0)).collect();
    let png = SHCreateItemFromParsingName::<_, _, IShellItemImageFactory>(PCWSTR(path.as_ptr()), None)
        .and_then(|factory| factory.GetImage(SIZE { cx: 32, cy: 32 }, SIIGBF_ICONONLY))
        .ok()
        .and_then(|bitmap| {
            let png = crate::encode_bitmap(bitmap, false);
            let _ = DeleteObject(bitmap.into());
            png
        });
    if com {
        CoUninitialize();
    }
    png
}

/// Moves a window so its visible frame fills the rectangle (physical
/// pixels). Windows 10 and 11 draw an invisible resize border around most
/// windows, outside the frame you see; the window is made that much bigger,
/// or neighbours would show a gap between them.
#[cfg(windows)]
unsafe fn place(hwnd: windows::Win32::Foundation::HWND, x: i32, y: i32, width: i32, height: i32) -> windows::core::Result<()> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsIconic, IsWindowArranged, IsZoomed, SetWindowPos, ShowWindow, HWND_TOP, SWP_NOACTIVATE,
        SWP_NOOWNERZORDER, SW_RESTORE,
    };

    // A maximized or minimized window ignores a new size until restored, and
    // so does one Windows snapped (arranged): moved as it is, Windows unsnaps
    // it back to its size from before, over ours.
    if IsIconic(hwnd).as_bool() || IsZoomed(hwnd).as_bool() || IsWindowArranged(hwnd).as_bool() {
        let _ = ShowWindow(hwnd, SW_RESTORE);
    }
    // Twice: moved onto a monitor of another scale, the window resizes itself
    // for it, and its border changes with the scale.
    for _ in 0..2 {
        let (mut outer, mut frame) = (RECT::default(), RECT::default());
        GetWindowRect(hwnd, &mut outer)?;
        let border = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut frame as *mut _ as *mut _,
            size_of::<RECT>() as u32,
        )
        .map(|_| (frame.left - outer.left, frame.top - outer.top, outer.right - frame.right, outer.bottom - frame.bottom))
        .unwrap_or_default();
        let (l, t, r, b) = border;
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            x - l,
            y - t,
            width + l + r,
            height + t + b,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )?;
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::Opened;

    #[test]
    fn a_file_is_known_by_its_name_in_a_title() {
        let hint = |path| Opened::File(path).title_hint();
        assert_eq!(hint(r"C:\Docs\Report Q3.PDF").as_deref(), Some("report q3"));
        assert_eq!(hint(r"C:\Docs\notes.tar.gz").as_deref(), Some("notes.tar"));
        // Too short to pick its window out from the others.
        assert_eq!(hint(r"C:\Docs\a.txt"), None);
        assert_eq!(Opened::App("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App").title_hint(), None);
    }
}
