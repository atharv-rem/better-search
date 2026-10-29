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
    /// Reading the text in images with Windows' OCR (images.rs).
    pub images: ImageSettings,
    /// The search window's zoom, on top of Windows' display scaling: 1.0 is
    /// 100%. Changed in steps of `UI_SCALE_STEP`.
    pub ui_scale: f64,
    /// The first-run screen (admin rights, then the first index) has been
    /// finished or skipped. A settings file from before it existed counts as
    /// done, so only a fresh install sees it.
    #[serde(default = "done")]
    pub onboarded: bool,
    /// The folder the search index is in when the user moved it to another
    /// drive; empty for the default place (storage.rs). Changed only by
    /// `storage::move_index`, which moves the files too.
    pub index_folder: String,
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
    /// What a search starts with to search inside files (with Windows Search)
    /// instead of their names, like "\". It pairs with the web search's "/",
    /// and no file name can contain it.
    pub content_trigger: String,
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
    /// What a search starts with to search the web instead of files, like "/".
    pub trigger: String,
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

/// Off until the user turns it on: reading every image takes a while, and
/// the text takes some space (images.db, apart from the index).
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ImageSettings {
    pub enabled: bool,
    /// Folders whose images are read, subfolders included; empty for the
    /// user's Desktop, Documents, Pictures and Downloads.
    pub folders: Vec<String>,
}

pub const DEFAULT_SHORTCUT: &str = "Alt+S";
const DEFAULT_WEB_TRIGGER: &str = "/";
/// The first is the default; the others stand in when the web search's
/// shortcut already is it.
const CONTENT_TRIGGERS: [&str; 3] = ["\\", ";", "~"];
const UI_SCALE_STEP: f64 = 0.1;
const ENGINES: [&str; 9] = [
    "google",
    "bing",
    "duckduckgo",
    "brave",
    "google-ai",
    "chatgpt",
    "claude",
    "perplexity",
    "custom",
];

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.into(),
            search: SearchSettings::default(),
            web: WebSettings::default(),
            indexing: IndexingSettings::default(),
            images: ImageSettings::default(),
            ui_scale: 1.0,
            onboarded: false,
            index_folder: String::new(),
        }
    }
}

impl Default for SearchSettings {
    fn default() -> Self {
        Self {
            max_results: 50,
            enter_reveals: false,
            clear_on_close: false,
            show_preview: true,
            remember_recent: true,
            content_trigger: CONTENT_TRIGGERS[0].into(),
        }
    }
}

impl Default for WebSettings {
    fn default() -> Self {
        Self { engine: "google".into(), custom_url: String::new(), browser: "default".into(), provider: "browser".into(), trigger: DEFAULT_WEB_TRIGGER.into() }
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
        Ok(text) => with_free_content_trigger(serde_json::from_str(&text).unwrap_or_else(|e| {
            log::warn!("Ignoring unreadable {}: {e}", path.display());
            Settings::default()
        })),
        Err(_) => Settings::default(),
    }
}

/// One shortcut starting with the other would leave one of the two searches
/// out of reach.
fn triggers_clash(a: &str, b: &str) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

/// Settings from before the content search have its default shortcut, which
/// the web search's may already be: another then, or every save would fail.
fn with_free_content_trigger(mut s: Settings) -> Settings {
    if triggers_clash(&s.search.content_trigger, &s.web.trigger) {
        if let Some(t) = CONTENT_TRIGGERS.iter().find(|t| !triggers_clash(t, &s.web.trigger)) {
            s.search.content_trigger = (*t).into();
        }
    }
    s
}

/// Writes to a temporary file first, so the indexer never reads half a file.
pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
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
    s.ui_scale = if s.ui_scale.is_finite() {
        ((s.ui_scale / UI_SCALE_STEP).round() * UI_SCALE_STEP).clamp(0.7, 1.5)
    } else {
        1.0
    };

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

    // Symbols only, so it can't swallow ordinary file searches.
    s.web.trigger = s.web.trigger.trim().to_string();
    let n = s.web.trigger.chars().count();
    if !(1..=2).contains(&n) || !s.web.trigger.chars().all(|c| c.is_ascii_punctuation()) {
        return Err("The web search shortcut has to be one or two symbols, like / or ?".into());
    }
    // "=" starts a calculation; as the trigger it would turn every one into a
    // web search.
    if s.web.trigger.starts_with('=') {
        return Err("= is the calculator's; pick another symbol for web search".into());
    }
    s.search.content_trigger = s.search.content_trigger.trim().to_string();
    let n = s.search.content_trigger.chars().count();
    if !(1..=2).contains(&n) || !s.search.content_trigger.chars().all(|c| c.is_ascii_punctuation()) {
        return Err("The file contents shortcut has to be one or two symbols, like \\ or ;".into());
    }
    if s.search.content_trigger.starts_with('=') {
        return Err("= is the calculator's; pick another symbol for searching file contents".into());
    }
    if triggers_clash(&s.search.content_trigger, &s.web.trigger) {
        return Err(format!(
            "{} is too close to the web search's {}; pick a symbol that doesn't start with the other",
            s.search.content_trigger, s.web.trigger
        ));
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

    let mut folders: Vec<String> = Vec::new();
    for f in &s.images.folders {
        let f = f.trim().trim_end_matches(['\\', '/']).to_string();
        if !f.is_empty() && !folders.iter().any(|g| g.eq_ignore_ascii_case(&f)) {
            folders.push(f);
        }
    }
    s.images.folders = folders;
    Ok(s)
}

/// Opens the search in snap mode (snap.rs). Fixed for now; it goes along
/// whenever the search's shortcut is registered.
const SNAP_SHORTCUT: &str = "Alt+W";

/// Makes `accelerator` open and close the search, and `SNAP_SHORTCUT` the
/// snap mode. Only the search's shortcut can fail: without the snap one
/// (another app has it, or it's the search's own) the app works on.
pub fn register_shortcut(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut = Shortcut::from_str(accelerator).map_err(|e| format!("{accelerator} isn't a shortcut: {e}"))?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                crate::toggle_search(app, crate::Mode::Search);
            }
        })
        .map_err(|e| {
            log::warn!("Failed to register {accelerator}: {e}");
            format!("{accelerator} is already used by another app.")
        })?;
    let snap = Shortcut::from_str(SNAP_SHORTCUT).expect("SNAP_SHORTCUT parses");
    if snap != shortcut {
        let registered = app.global_shortcut().on_shortcut(snap, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                crate::toggle_search(app, crate::Mode::Snap);
            }
        });
        if let Err(e) = registered {
            log::warn!("Failed to register {SNAP_SHORTCUT}: {e}");
        }
    }
    Ok(())
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
    let mut settings = validate(settings)?;
    let mut current = state.0.lock().unwrap();
    // Only moving the files changes where they are.
    settings.index_folder = current.index_folder.clone();
    if !settings.shortcut.eq_ignore_ascii_case(&current.shortcut) {
        let _ = app.global_shortcut().unregister_all();
        if let Err(e) = register_shortcut(&app, &settings.shortcut) {
            let _ = register_shortcut(&app, &current.shortcut);
            return Err(e);
        }
    }
    save(&app, &settings)?;
    if settings.ui_scale != current.ui_scale {
        crate::scale_settings_window(&app, settings.ui_scale);
    }
    // Turned off: forget the ones kept so far too.
    if !settings.search.remember_recent {
        if let Err(e) = crate::recent::clear(&app) {
            log::warn!("Couldn't clear recent searches: {e}");
        }
    }
    let old_images = std::mem::replace(&mut *current, settings.clone()).images;
    drop(current);
    let _ = app.emit("settings-changed", &settings);
    crate::images::settings_changed(&app, &old_images, &settings.images);
    Ok(settings)
}

/// Turns image indexing on or off from the shell (`delete_image_index`),
/// saving and telling every window as `update_settings` does.
pub fn set_images_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<SettingsState>();
    let mut current = state.0.lock().unwrap();
    if current.images.enabled == enabled {
        return Ok(());
    }
    let mut settings = current.clone();
    settings.images.enabled = enabled;
    save(app, &settings)?;
    *current = settings.clone();
    drop(current);
    let _ = app.emit("settings-changed", &settings);
    Ok(())
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
    pub letter: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn with_trigger(trigger: &str) -> Result<Settings, String> {
        let mut s = Settings::default();
        s.web.trigger = trigger.into();
        validate(s)
    }

    #[test]
    fn web_trigger_is_one_or_two_symbols() {
        assert_eq!(with_trigger(" ?? ").unwrap().web.trigger, "??");
        assert!(with_trigger("").is_err());
        assert!(with_trigger("abc").is_err());
        assert!(with_trigger("///").is_err());
    }

    fn with_content_trigger(trigger: &str) -> Result<Settings, String> {
        let mut s = Settings::default();
        s.search.content_trigger = trigger.into();
        validate(s)
    }

    #[test]
    fn content_trigger_is_symbols_apart_from_the_others() {
        assert_eq!(with_content_trigger(" ## ").unwrap().search.content_trigger, "##");
        assert!(with_content_trigger("").is_err());
        assert!(with_content_trigger("in").is_err());
        assert!(with_content_trigger("=").is_err());
        // The web search's is "/" by default.
        assert!(with_content_trigger("/").is_err());
        assert!(with_content_trigger("//").is_err());
        assert!(with_trigger("\\").is_err());
        assert!(with_trigger("\\/").is_err());
    }

    #[test]
    fn old_settings_get_a_free_content_trigger() {
        let mut s = Settings::default();
        s.web.trigger = "\\".into();
        assert_eq!(with_free_content_trigger(s.clone()).search.content_trigger, ";");
        assert!(validate(with_free_content_trigger(s)).is_ok());
        assert_eq!(with_free_content_trigger(Settings::default()).search.content_trigger, "\\");
    }

    #[test]
    fn image_folders_are_tidied() {
        let mut s = Settings::default();
        s.images.folders = vec![r" C:\Notes\ ".into(), r"c:\notes".into(), "".into(), "D:/Shots/".into()];
        assert_eq!(validate(s).unwrap().images.folders, vec![r"C:\Notes".to_string(), "D:/Shots".to_string()]);
        // Off by default, and settings from before it have it off.
        assert!(!Settings::default().images.enabled);
        let old: Settings = serde_json::from_str(r#"{"shortcut":"Alt+S"}"#).unwrap();
        assert!(!old.images.enabled && old.images.folders.is_empty());
    }

    #[test]
    fn web_trigger_leaves_the_calculator_its_equals() {
        assert!(with_trigger("=").is_err());
        assert!(with_trigger("=/").is_err());
        assert!(with_trigger("/=").is_ok());
    }
}
