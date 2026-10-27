//! The last searches, listed under the empty search box. In recent.json in the
//! app's data folder; nothing is kept while the "remember_recent" setting is
//! off. A search counts once something came of it: a result opened, or a web
//! search run.

use std::{path::PathBuf, sync::Mutex};

use tauri::{AppHandle, Manager, State};

use crate::settings::SettingsState;

/// Searches kept; the search box lists the newest few.
const LIMIT: usize = 20;

static WRITING: Mutex<()> = Mutex::new(());

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("recent.json"))
}

/// Newest first. The search page gets them with every show (lib.rs
/// `ShownState`).
pub fn read(app: &AppHandle) -> Vec<String> {
    path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Forgets them all.
pub fn clear(app: &AppHandle) -> Result<(), String> {
    let _writing = WRITING.lock().unwrap();
    let Some(path) = path(app) else { return Ok(()) };
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Puts `query` first (once) and gives the new list.
#[tauri::command]
pub fn add_recent_search(app: AppHandle, state: State<'_, SettingsState>, query: String) -> Result<Vec<String>, String> {
    if !state.0.lock().unwrap().search.remember_recent {
        return Ok(Vec::new());
    }
    let query = query.trim();
    if query.is_empty() || query.len() > 500 {
        return Ok(read(&app));
    }
    let _writing = WRITING.lock().unwrap();
    let mut list = read(&app);
    list.retain(|q| q != query);
    list.insert(0, query.to_string());
    list.truncate(LIMIT);
    let path = path(&app).ok_or("no data folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(list)
}

#[tauri::command]
pub fn clear_recent_searches(app: AppHandle) -> Result<(), String> {
    clear(&app)
}
