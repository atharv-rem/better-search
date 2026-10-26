//! Where the search index lives. By default in the app's local data folder
//! on the Windows drive, the backend's own default (database.DefaultPath).
//! When that drive is short of space the user can keep it on another one, in
//! `INDEX_FOLDER` at that drive's root (`Settings::index_folder`); the index
//! still covers every drive, only the file moves. The helper and the watcher
//! get its path as `-db`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_log::log;

use crate::settings::{self, Settings, SettingsState};

/// The folder made at the root of a drive the index is moved to.
const INDEX_FOLDER: &str = "better-search-data";

/// The index and its WAL. The shared-memory file is rebuilt from them.
const INDEX_FILES: [&str; 2] = ["index.db", "index.db-wal"];

/// Matches database.MinFreeSpace: enough for ~400,000 files.
const MIN_FREE_SPACE: u64 = 300 << 20;

/// Where the uninstaller looks for a moved index (hooks.nsh), as it can't
/// read settings.json.
#[cfg(windows)]
const UNINSTALL_KEY: &str = r"Software\better-search";

fn default_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map_err(|e| e.to_string())
}

/// The folder the index is in.
pub fn index_dir(app: &AppHandle, settings: &Settings) -> Result<PathBuf, String> {
    if settings.index_folder.is_empty() {
        default_dir(app)
    } else {
        Ok(PathBuf::from(&settings.index_folder))
    }
}

/// The `-db` to start the backend with: none for the default place, so an
/// index that never moved is opened exactly as before.
pub fn db_arg(app: &AppHandle) -> Option<PathBuf> {
    let folder = app.state::<SettingsState>().0.lock().unwrap().index_folder.clone();
    (!folder.is_empty()).then(|| PathBuf::from(folder).join("index.db"))
}

fn index_bytes(dir: &Path) -> u64 {
    INDEX_FILES.iter().filter_map(|f| std::fs::metadata(dir.join(f)).ok()).map(|m| m.len()).sum()
}

/// Free space a full index wants, like database.SpaceNeeded: at its peak it
/// holds the old index, the new one and the search tables being rebuilt.
fn space_needed(index_bytes: u64) -> u64 {
    MIN_FREE_SPACE.max(3 * index_bytes)
}

/// "C:" for C:\anything.
fn drive_of(path: &Path) -> String {
    path.to_string_lossy().chars().take(2).collect::<String>().to_uppercase()
}

#[cfg(windows)]
fn free_space(drive: &str) -> u64 {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let root: Vec<u16> = format!("{drive}\\").encode_utf16().chain(Some(0)).collect();
    let mut free = 0u64;
    let _ = unsafe { GetDiskFreeSpaceExW(PCWSTR(root.as_ptr()), Some(&mut free), None, None) };
    free
}

#[cfg(not(windows))]
fn free_space(_drive: &str) -> u64 {
    0
}

#[derive(Serialize)]
pub struct IndexLocation {
    /// The folder the index is in.
    folder: String,
    /// "C:"
    drive: String,
    /// The drive the index is on when it hasn't been moved.
    default_drive: String,
    index_bytes: u64,
    /// Free space a full index wants on its drive.
    needed_bytes: u64,
    free_bytes: u64,
}

fn location(app: &AppHandle, settings: &Settings) -> Result<IndexLocation, String> {
    let dir = index_dir(app, settings)?;
    let drive = drive_of(&dir);
    let bytes = index_bytes(&dir);
    Ok(IndexLocation {
        folder: dir.to_string_lossy().into_owned(),
        free_bytes: free_space(&drive),
        drive,
        default_drive: drive_of(&default_dir(app)?),
        index_bytes: bytes,
        needed_bytes: space_needed(bytes),
    })
}

#[tauri::command]
pub fn index_location(app: AppHandle, state: State<'_, SettingsState>) -> Result<IndexLocation, String> {
    let settings = state.0.lock().unwrap().clone();
    location(&app, &settings)
}

/// Moves the index to `drive` ("D:"): to `INDEX_FOLDER` at its root, or back
/// to the default folder for the default drive. The helper and the watcher
/// are stopped while the files are copied, and started again on the new path.
/// Not while indexing: the page doesn't offer it then.
#[tauri::command]
pub async fn move_index(app: AppHandle, drive: String) -> Result<IndexLocation, String> {
    let task = app.clone();
    tauri::async_runtime::spawn_blocking(move || move_to(&task, &drive))
        .await
        .map_err(|e| e.to_string())?
}

fn move_to(app: &AppHandle, drive: &str) -> Result<IndexLocation, String> {
    let drive = drive.trim_end_matches('\\').to_uppercase();
    let fixed = settings::list_drives().into_iter().any(|d| d.letter.eq_ignore_ascii_case(&drive));
    if !fixed {
        return Err(format!("{drive} isn't a drive in this computer."));
    }

    let current = app.state::<SettingsState>().0.lock().unwrap().clone();
    let from = index_dir(app, &current)?;
    let default = default_dir(app)?;
    let (to, folder) = if drive == drive_of(&default) {
        (default, String::new())
    } else {
        let dir = PathBuf::from(format!("{drive}\\{INDEX_FOLDER}"));
        let folder = dir.to_string_lossy().into_owned();
        (dir, folder)
    };
    if to == from {
        return location(app, &current);
    }
    // The helper holds it, with no sharing, while it indexes.
    if from.join("index.lock").exists() && std::fs::remove_file(from.join("index.lock")).is_err() {
        return Err("Wait for indexing to finish, then move the index.".into());
    }
    let size = index_bytes(&from);
    let (needed, free) = (space_needed(size), free_space(&drive));
    if free < needed {
        return Err(format!(
            "{drive} has {} MB free. The index needs about {} MB there.",
            free >> 20,
            needed >> 20
        ));
    }
    std::fs::create_dir_all(&to).map_err(|e| format!("Couldn't make {}: {e}", to.display()))?;

    crate::stop_backend(app);
    crate::stop_watcher(app);
    let moved = copy_index(&from, &to).and_then(|_| {
        let settings = Settings { index_folder: folder.clone(), ..current.clone() };
        settings::save(app, &settings)?;
        *app.state::<SettingsState>().0.lock().unwrap() = settings.clone();
        let _ = app.emit("settings-changed", &settings);
        Ok(settings)
    });
    let result = match moved {
        Ok(settings) => {
            log::info!("Moved the index from {} to {}", from.display(), to.display());
            remember_for_uninstall(&folder);
            remove_index(&from);
            if !current.index_folder.is_empty() {
                let _ = std::fs::remove_dir(&from); // only if nothing else is in it
            }
            location(app, &settings)
        }
        Err(e) => {
            remove_index(&to);
            Err(format!("Couldn't move the index: {e}"))
        }
    };
    crate::start_watcher(app);
    crate::start_backend(app);
    result
}

/// Copies the index, with its WAL, over whatever an earlier move left in `to`.
fn copy_index(from: &Path, to: &Path) -> Result<(), String> {
    remove_index(to);
    for f in INDEX_FILES {
        let src = from.join(f);
        if !src.exists() {
            continue;
        }
        // The stopped processes may hold the files a moment longer.
        let mut tries = 0;
        loop {
            match std::fs::copy(&src, to.join(f)) {
                Ok(_) => break,
                Err(_) if tries < 20 => {
                    tries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    }
    Ok(())
}

/// Deletes the index files in `dir`, waiting a moment for stopped processes
/// to let go of them.
fn remove_index(dir: &Path) {
    for f in INDEX_FILES.iter().copied().chain(["index.db-shm"]) {
        let path = dir.join(f);
        for _ in 0..20 {
            if !path.exists() || std::fs::remove_file(&path).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

/// The uninstaller deletes a moved index along with the app's other data.
#[cfg(windows)]
fn remember_for_uninstall(folder: &str) {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let result = if folder.is_empty() {
        hkcu.delete_subkey_all(UNINSTALL_KEY).or_else(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(e),
        })
    } else {
        hkcu.create_subkey(UNINSTALL_KEY).and_then(|(key, _)| key.set_value("IndexFolder", &folder))
    };
    if let Err(e) = result {
        log::warn!("Couldn't record the index folder for the uninstaller: {e}");
    }
}

#[cfg(not(windows))]
fn remember_for_uninstall(_folder: &str) {}
