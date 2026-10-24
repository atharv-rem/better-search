//! The user's settings, in settings.json in the app's config folder. The shell
//! owns the file: the pages read and change it with `get_settings` and
//! `update_settings`, and the backend's indexer reads its "indexing" section
//! (the sidecar gets the path as `-settings`).

use std::{path::PathBuf, str::FromStr, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_log::log;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Opens and closes the search, as an accelerator like "Alt+S".
    pub shortcut: String,
    pub search: SearchSettings,
    pub web: WebSettings,
    pub indexing: IndexingSettings,
    /// The first-run screen (admin rights, then the first index) has been
    /// finished or skipped. A settings file from before it existed counts as
    /// done, so only a fresh install sees it.
    #[serde(default = "done")]
    pub onboarded: bool,
}

fn done() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchSettings {
    pub max_results: u32,
    /// Enter shows the result in Explorer and Ctrl+Enter opens it, instead
    /// of the other way round.
    pub enter_reveals: bool,
    /// Every search starts from an empty box instead of the last query.
    pub clear_on_close: bool,
    pub show_preview: bool,
    /// List the last searches under the empty search box (recent.rs).
    pub remember_recent: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WebSettings {
    /// One of `ENGINES`.
    pub engine: String,
    /// For the "custom" engine: an https URL with %s where the query goes.
    pub custom_url: String,
    /// A browser id from `list_browsers`, or "default".
    pub browser: String,
    /// "browser" opens web searches in the browser; one of
    /// `web_search::PROVIDERS` shows its results in the search window, with
    /// the user's key for it.
    pub provider: String,
}

/// Read by the backend's indexer (indexer/options.go); they apply the next
/// time the index is rebuilt.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct IndexingSettings {
    /// Drives not to index, like "D:".
    pub excluded_drives: Vec<String>,
    /// Full paths, or folder names skipped wherever they are.
    pub excluded_folders: Vec<String>,
}

pub const DEFAULT_SHORTCUT: &str = "Alt+S";
const ENGINES: [&str; 5] = ["google", "bing", "duckduckgo", "brave", "custom"];

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.into(),
            search: SearchSettings::default(),
            web: WebSettings::default(),
            indexing: IndexingSettings::default(),
            onboarded: false,
        }
    }
}

impl Default for SearchSettings {
    fn default() -> Self {
        Self { max_results: 50, enter_reveals: false, clear_on_close: false, show_preview: true, remember_recent: true }
    }
}

impl Default for WebSettings {
    fn default() -> Self {
        Self { engine: "google".into(), custom_url: String::new(), browser: "default".into(), provider: "browser".into() }
    }
}

pub struct SettingsState(pub Mutex<Settings>);

pub fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

/// The saved settings, or the defaults when there are none yet (or the file
/// can't be read). Fields missing from the file get their defaults.
pub fn load(app: &AppHandle) -> Settings {
    let Some(path) = path(app) else { return Settings::default() };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            log::warn!("Ignoring unreadable {}: {e}", path.display());
            Settings::default()
        }),
        Err(_) => Settings::default(),
    }
}

/// Writes to a temporary file first, so the indexer never reads half a file.
fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = path(app).ok_or("no config folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn validate(mut s: Settings) -> Result<Settings, String> {
    s.shortcut = s.shortcut.trim().to_string();
    Shortcut::from_str(&s.shortcut).map_err(|e| format!("{} isn't a shortcut: {e}", s.shortcut))?;

    s.search.max_results = s.search.max_results.clamp(10, 500);

    if !ENGINES.contains(&s.web.engine.as_str()) {
        s.web.engine = "google".into();
    }
    s.web.custom_url = s.web.custom_url.trim().to_string();
    if s.web.engine == "custom" && (!s.web.custom_url.starts_with("https://") || !s.web.custom_url.contains("%s")) {
        return Err("The search URL has to start with https:// and have %s where the search goes.".into());
    }
    if !crate::web_search::PROVIDERS.contains(&s.web.provider.as_str()) {
        s.web.provider = "browser".into();
    }

    let mut folders: Vec<String> = Vec::new();
    for f in &s.indexing.excluded_folders {
        let f = f.trim().trim_end_matches(['\\', '/']).to_string();
        if !f.is_empty() && !folders.iter().any(|g| g.eq_ignore_ascii_case(&f)) {
            folders.push(f);
        }
    }
    s.indexing.excluded_folders = folders;
    for d in &mut s.indexing.excluded_drives {
        *d = d.trim_end_matches('\\').to_uppercase();
    }
    s.indexing.excluded_drives.dedup();
    Ok(s)
}

/// Makes `accelerator` open and close the search.
pub fn register_shortcut(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut = Shortcut::from_str(accelerator).map_err(|e| format!("{accelerator} isn't a shortcut: {e}"))?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                crate::toggle_search(app);
            }
        })
        .map_err(|e| {
            log::warn!("Failed to register {accelerator}: {e}");
            format!("{accelerator} is already used by another app.")
        })
}

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

/// Saves the whole settings and tells every window ("settings-changed"). A
/// new shortcut is registered first: if another app has it, nothing is saved
/// and the old one stays.
#[tauri::command]
pub fn update_settings(app: AppHandle, state: State<'_, SettingsState>, settings: Settings) -> Result<Settings, String> {
    let settings = validate(settings)?;
    let mut current = state.0.lock().unwrap();
    if !settings.shortcut.eq_ignore_ascii_case(&current.shortcut) {
        let _ = app.global_shortcut().unregister_all();
        if let Err(e) = register_shortcut(&app, &settings.shortcut) {
            let _ = register_shortcut(&app, &current.shortcut);
            return Err(e);
        }
    }
    save(&app, &settings)?;
    // Turned off: forget the ones kept so far too.
    if !settings.search.remember_recent {
        if let Err(e) = crate::recent::clear(&app) {
            log::warn!("Couldn't clear recent searches: {e}");
        }
    }
    *current = settings.clone();
    let _ = app.emit("settings-changed", &settings);
    Ok(settings)
}

/// Turns the shortcut off while the settings page records a new one, so
/// pressing the current one doesn't open the search.
#[tauri::command]
pub fn pause_shortcut(app: AppHandle, state: State<'_, SettingsState>, paused: bool) -> Result<(), String> {
    let _ = app.global_shortcut().unregister_all();
    if paused {
        return Ok(());
    }
    let shortcut = state.0.lock().unwrap().shortcut.clone();
    register_shortcut(&app, &shortcut)
}

/// A fixed drive the indexer could read.
#[derive(Serialize)]
pub struct Drive {
    /// "C:"
    letter: String,
    label: String,
    /// The indexer reads NTFS drives only.
    ntfs: bool,
    total_bytes: u64,
    free_bytes: u64,
}

#[cfg(windows)]
#[tauri::command]
pub fn list_drives() -> Vec<Drive> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};

    const DRIVE_FIXED: u32 = 3;
    let mask = unsafe { GetLogicalDrives() };
    let mut drives = Vec::new();
    for i in 0..26u8 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = format!("{}:", (b'A' + i) as char);
        let root: Vec<u16> = format!("{letter}\\").encode_utf16().chain(Some(0)).collect();
        let root = PCWSTR(root.as_ptr());
        if unsafe { GetDriveTypeW(root) } != DRIVE_FIXED {
            continue;
        }
        let mut label = [0u16; 261];
        let mut fs = [0u16; 261];
        let has_info = unsafe { GetVolumeInformationW(root, Some(&mut label), None, None, None, Some(&mut fs)) }.is_ok();
        let text = |buf: &[u16]| String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]);
        let (mut free, mut total) = (0u64, 0u64);
        let _ = unsafe { GetDiskFreeSpaceExW(root, Some(&mut free), Some(&mut total), None) };
        drives.push(Drive {
            letter,
            label: if has_info { text(&label) } else { String::new() },
            ntfs: has_info && text(&fs).eq_ignore_ascii_case("NTFS"),
            total_bytes: total,
            free_bytes: free,
        });
    }
    drives
}

#[cfg(not(windows))]
#[tauri::command]
pub fn list_drives() -> Vec<Drive> {
    Vec::new()
}

/// What the app keeps on disk, in its local data folder.
#[derive(Serialize)]
pub struct StorageUsage {
    /// The backend's SQLite index (database.DefaultPath), with its WAL files.
    index_bytes: u64,
}

#[tauri::command]
pub fn storage_usage(app: AppHandle) -> Result<StorageUsage, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let index_bytes = ["index.db", "index.db-wal", "index.db-shm"]
        .iter()
        .filter_map(|f| std::fs::metadata(dir.join(f)).ok())
        .map(|m| m.len())
        .sum();
    Ok(StorageUsage { index_bytes })
}
