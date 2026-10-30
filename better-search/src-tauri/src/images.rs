//! Reads the text in the user's images with Windows' own OCR, so a content
//! search ("\ elasticity") finds screenshots and photos of notes by their
//! words. The backend keeps the text in images.db, apart from the search
//! index, so deleting it gives all its space back (`delete_image_index`).
//!
//! Off until the user turns it on, in the first-run screen or in settings.
//! While on, the folders are checked for new and changed images when the app
//! starts and every hour; each image is read once.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::log;

use crate::settings::{ImageSettings, SettingsState};

/// After start-up, out of the way of the first search; then this often.
const FIRST_RUN_DELAY: Duration = Duration::from_secs(30);
const RERUN_EVERY: Duration = Duration::from_secs(60 * 60);
/// What's been read is handed to the backend this often, so a search finds
/// it soon and quitting midway loses little.
const BATCH: usize = 16;
const BATCH_TIME: Duration = Duration::from_secs(2);
/// This many failures in a row, before anything was read, means the OCR
/// itself is broken: stop rather than mark every image as read, empty.
const GIVE_UP_AFTER: usize = 8;

#[derive(Default)]
pub struct ImageIndex {
    running: AtomicBool,
    cancel: AtomicBool,
    /// Settings changed while running: run again once done.
    again: AtomicBool,
    progress: Mutex<Progress>,
}

/// Sent to every window as "image-index-progress".
#[derive(Clone, Default, Serialize)]
pub struct Progress {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Image {
    path: String,
    mtime: i64,
    size: i64,
    #[serde(default)]
    text: String,
}

/// The folders read: the user's own list, or their Desktop, Documents,
/// Pictures and Downloads (OneDrive's when it keeps them).
pub fn folders(app: &AppHandle, settings: &ImageSettings) -> Vec<String> {
    if !settings.folders.is_empty() {
        return settings.folders.clone();
    }
    let path = app.path();
    [path.desktop_dir(), path.document_dir(), path.picture_dir(), path.download_dir()]
        .into_iter()
        .flatten()
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Reads new and changed images in the background, if image indexing is on.
pub fn start(app: &AppHandle) {
    let settings = app.state::<SettingsState>().0.lock().unwrap().images.clone();
    if !settings.enabled {
        return;
    }
    let state = app.state::<ImageIndex>();
    if state.running.swap(true, Ordering::SeqCst) {
        state.again.store(true, Ordering::SeqCst);
        return;
    }
    state.cancel.store(false, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        background_priority(true);
        loop {
            run(&app);
            let state = app.state::<ImageIndex>();
            if state.cancel.load(Ordering::SeqCst) || !state.again.swap(false, Ordering::SeqCst) {
                break;
            }
        }
        background_priority(false);
        let state = app.state::<ImageIndex>();
        state.running.store(false, Ordering::SeqCst);
        let mut p = state.progress.lock().unwrap();
        p.running = false;
        let _ = app.emit("image-index-progress", p.clone());
        drop(p);
        // What the OCR engine and the backend's writes used would otherwise
        // stay in memory until a window is next shown and hidden.
        crate::idle_if_hidden(&app);
    });
}

/// Stops reading after the current image.
pub fn stop(app: &AppHandle) {
    app.state::<ImageIndex>().cancel.store(true, Ordering::SeqCst);
}

/// Settings were saved: start on turning on or changing the folders, stop
/// on turning off.
pub fn settings_changed(app: &AppHandle, old: &ImageSettings, new: &ImageSettings) {
    if new.enabled && (!old.enabled || old.folders != new.folders) {
        start(app);
    } else if !new.enabled && old.enabled {
        stop(app);
    }
}

/// Runs `start` a little after start-up, then every hour for images added
/// since.
pub fn schedule(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_RUN_DELAY).await;
        loop {
            start(&app);
            tokio::time::sleep(RERUN_EVERY).await;
        }
    });
}

fn set_progress(app: &AppHandle, change: impl FnOnce(&mut Progress)) {
    let state = app.state::<ImageIndex>();
    let mut p = state.progress.lock().unwrap();
    change(&mut p);
    let _ = app.emit("image-index-progress", p.clone());
}

fn run(app: &AppHandle) {
    let settings = app.state::<SettingsState>().0.lock().unwrap().images.clone();
    let folders = folders(app, &settings);
    let pending: Vec<Image> = match call(app, serde_json::json!({ "type": "images_scan", "folders": folders })) {
        Ok(data) => serde_json::from_value(data["pending"].clone()).unwrap_or_default(),
        Err(e) => {
            log::warn!("Image indexing: couldn't list the images: {e}");
            set_progress(app, |p| p.error = Some(e));
            return;
        }
    };
    set_progress(app, |p| *p = Progress { running: true, done: 0, total: pending.len(), error: None });
    if pending.is_empty() {
        return;
    }
    log::info!("Image indexing: {} images to read", pending.len());
    let started = Instant::now();

    let com = com_init();
    let Some(ocr) = Ocr::new() else {
        if com {
            com_uninit();
        }
        let e = "Windows has no OCR language installed. Add a language with text recognition in Windows' language settings.".to_string();
        log::warn!("Image indexing: {e}");
        set_progress(app, |p| p.error = Some(e));
        return;
    };

    let mut batch: Vec<Image> = Vec::with_capacity(BATCH);
    let mut flushed = Instant::now();
    let (mut read, mut failed_in_a_row, mut done) = (0usize, 0usize, 0usize);
    let flush = |batch: &mut Vec<Image>| {
        if batch.is_empty() {
            return true;
        }
        match call(app, serde_json::json!({ "type": "images_add", "images": &*batch })) {
            Ok(_) => {
                batch.clear();
                true
            }
            Err(e) => {
                log::warn!("Image indexing: couldn't save what was read: {e}");
                false
            }
        }
    };
    for mut img in pending {
        if app.state::<ImageIndex>().cancel.load(Ordering::SeqCst) {
            break;
        }
        match ocr.read(&img.path) {
            Ok(text) => {
                img.text = text;
                read += 1;
                failed_in_a_row = 0;
            }
            Err(e) => {
                failed_in_a_row += 1;
                if read == 0 && failed_in_a_row >= GIVE_UP_AFTER {
                    let e = format!("Windows' OCR couldn't read images ({e})");
                    log::warn!("Image indexing: {e}");
                    set_progress(app, |p| p.error = Some(e));
                    batch.clear();
                    break;
                }
                // Unreadable (a broken file, a format without a codec):
                // kept with no text, so it isn't tried again until it changes.
            }
        }
        batch.push(img);
        done += 1;
        if batch.len() >= BATCH || flushed.elapsed() >= BATCH_TIME {
            if !flush(&mut batch) {
                break;
            }
            flushed = Instant::now();
            set_progress(app, |p| p.done = done);
        }
    }
    flush(&mut batch);
    set_progress(app, |p| p.done = done);
    drop(ocr);
    if com {
        com_uninit();
    }
    log::info!("Image indexing: read {done} images in {:.1}s", started.elapsed().as_secs_f32());
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// One request to the backend, from this background thread; its data, or its
/// error.
fn call(app: &AppHandle, mut message: serde_json::Value) -> Result<serde_json::Value, String> {
    let id = format!("images-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    message["id"] = id.clone().into();
    let line = tauri::async_runtime::block_on(crate::backend_send(app, id, message.to_string()))?;
    reply_data(&line)
}

/// The data of a backend reply, or its error.
fn reply_data(line: &str) -> Result<serde_json::Value, String> {
    let reply: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if reply["status"] != "ok" {
        return Err(reply["error"].as_str().unwrap_or("backend error").to_string());
    }
    Ok(reply["data"].clone())
}

async fn call_async(app: &AppHandle, mut message: serde_json::Value) -> Result<serde_json::Value, String> {
    let id = format!("images-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    message["id"] = id.clone().into();
    reply_data(&crate::backend_send(app, id, message.to_string()).await?)
}

/// For the settings page.
#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    /// What's read: the user's list, or the default folders.
    folders: Vec<String>,
    /// The folders are the default ones, not chosen.
    default_folders: bool,
    progress: Progress,
    /// images.db: exists, images, with_text, bytes (images.go Stats).
    stored: serde_json::Value,
}

#[tauri::command]
pub async fn image_index_status(app: AppHandle) -> Result<Status, String> {
    let settings = app.state::<SettingsState>().0.lock().unwrap().images.clone();
    let progress = app.state::<ImageIndex>().progress.lock().unwrap().clone();
    let stored = call_async(&app, serde_json::json!({ "type": "images_status" })).await?;
    Ok(Status {
        enabled: settings.enabled,
        folders: folders(&app, &settings),
        default_folders: settings.folders.is_empty(),
        progress,
        stored,
    })
}

/// Turns image indexing off and deletes what it stored, for when space is short.
#[tauri::command]
pub async fn delete_image_index(app: AppHandle) -> Result<(), String> {
    crate::settings::set_images_enabled(&app, false)?;
    stop(&app);
    // The image being read finishes first.
    let state = app.state::<ImageIndex>();
    for _ in 0..100 {
        if !state.running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    call_async(&app, serde_json::json!({ "type": "images_delete" })).await?;
    set_progress(&app, |p| *p = Progress::default());
    Ok(())
}

#[cfg(windows)]
fn background_priority(on: bool) {
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN, THREAD_MODE_BACKGROUND_END};
    // Lower CPU and disk priority: reading images mustn't slow the user down.
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), if on { THREAD_MODE_BACKGROUND_BEGIN } else { THREAD_MODE_BACKGROUND_END });
    }
}

#[cfg(not(windows))]
fn background_priority(_on: bool) {}

/// Multithreaded, as pdf_first_page does: waiting on WinRT's async calls
/// (`join`) would block a single-threaded apartment's message loop.
#[cfg(windows)]
fn com_init() -> bool {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() }
}

#[cfg(windows)]
fn com_uninit() {
    unsafe { windows::Win32::System::Com::CoUninitialize() }
}

#[cfg(not(windows))]
fn com_init() -> bool {
    false
}

#[cfg(not(windows))]
fn com_uninit() {}

/// Longest side images are read at. A phone's 12-megapixel photo decodes to
/// ~48 MB of pixels; at this size it's ~19 MB, its text still reads, and a
/// screenshot is never shrunk.
#[cfg(windows)]
const MAX_SIDE: u32 = 2600;

/// Windows' OCR engine, for the languages in the user's profile.
#[cfg(windows)]
struct Ocr {
    engine: windows::Media::Ocr::OcrEngine,
    max: u32,
}

#[cfg(windows)]
impl Ocr {
    fn new() -> Option<Self> {
        use windows::Media::Ocr::OcrEngine;
        let engine = OcrEngine::TryCreateFromUserProfileLanguages().ok()?;
        let max = OcrEngine::MaxImageDimension().unwrap_or(4096).min(MAX_SIDE);
        Some(Self { engine, max })
    }

    /// The text in the image at `path`, a line per line; "" when it has none.
    fn read(&self, path: &str) -> windows::core::Result<String> {
        use windows::core::HSTRING;
        use windows::Graphics::Imaging::{
            BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
            ExifOrientationMode,
        };
        use windows::Storage::{FileAccessMode, StorageFile};

        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.join()?;
        let stream = file.OpenAsync(FileAccessMode::Read)?.join()?;
        let decoder = BitmapDecoder::CreateAsync(&stream)?.join()?;
        // The stored size: scaling comes before turning the image upright.
        let (width, height) = (decoder.PixelWidth()?, decoder.PixelHeight()?);
        // Under the engine's smallest size there's nothing it can read.
        if width < 40 || height < 40 {
            return Ok(String::new());
        }
        // Bigger than MAX_SIDE (a phone photo, a panorama): scaled down.
        let transform = BitmapTransform::new()?;
        let largest = width.max(height);
        if largest > self.max {
            let scale = self.max as f64 / largest as f64;
            transform.SetScaledWidth(((width as f64 * scale) as u32).max(1))?;
            transform.SetScaledHeight(((height as f64 * scale) as u32).max(1))?;
            transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
        }
        // A format the engine reads, whatever the file's (16-bit PNGs aren't);
        // turned upright, so a phone's sideways photo reads.
        let bitmap = decoder
            .GetSoftwareBitmapTransformedAsync(
                BitmapPixelFormat::Bgra8,
                BitmapAlphaMode::Premultiplied,
                &transform,
                ExifOrientationMode::RespectExifOrientation,
                ColorManagementMode::DoNotColorManage,
            )?
            .join()?;
        let result = self.engine.RecognizeAsync(&bitmap)?.join()?;
        let mut text = String::new();
        for line in result.Lines()? {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&line.Text()?.to_string_lossy());
        }
        stream.Close()?;
        Ok(text)
    }
}

#[cfg(not(windows))]
struct Ocr;

#[cfg(not(windows))]
impl Ocr {
    fn new() -> Option<Self> {
        None
    }
    fn read(&self, _path: &str) -> Result<String, String> {
        Err("no OCR".into())
    }
}
