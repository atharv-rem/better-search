use tauri::{AppHandle, Manager};
use tauri_plugin_log::log;

/// The log file, in the app's log folder (`LogDir` in `run`).
const FILE_NAME: &str = "better-search.log";

/// Writes a sidecar's line to the log. The Go programs have no levels of
/// their own: a line starting "ERROR: " or "WARN: " is logged at that level.
pub fn relay(source: &str, line: &[u8]) {
    let line = String::from_utf8_lossy(line);
    let line = line.trim_end();
    if let Some(msg) = line.strip_prefix("ERROR: ") {
        log::error!("[{source}] {msg}");
    } else if let Some(msg) = line.strip_prefix("WARN: ") {
        log::warn!("[{source}] {msg}");
    } else {
        log::info!("[{source}] {line}");
    }
}

#[derive(serde::Serialize)]
pub struct Problem {
    date: String,
    time: String,
    level: &'static str,
    source: String,
    message: String,
}

/// At most this many, newest first.
const MAX_PROBLEMS: usize = 200;

/// The warnings and errors in the log file, for the Troubleshooting page.
/// Async, so reading the file stays off the main thread.
#[tauri::command]
pub async fn recent_problems(app: AppHandle) -> Result<Vec<Problem>, String> {
    let path = app.path().app_log_dir().map_err(|e| e.to_string())?.join(FILE_NAME);
    let text = match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };

    let mut problems: Vec<Problem> = Vec::new();
    // Whether the last entry was kept, so the lines of a message that spans
    // several follow it.
    let mut kept = false;
    for line in text.lines() {
        let Some((date, time, target, level, message)) = parse(line) else {
            if kept {
                if let Some(last) = problems.last_mut() {
                    last.message.push('\n');
                    last.message.push_str(line);
                }
            }
            continue;
        };
        let level = match level {
            "ERROR" => "error",
            "WARN" => "warn",
            _ => {
                kept = false;
                continue;
            }
        };
        let (source, message) = source(target, message);
        problems.push(Problem {
            date: date.into(),
            time: time.into(),
            level,
            source,
            message: message.into(),
        });
        kept = true;
    }
    problems.reverse();
    problems.truncate(MAX_PROBLEMS);
    Ok(problems)
}

const LEVELS: [&str; 5] = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

/// "[2026-10-27][07:43:28][WARN][better_search_lib] message" in parts, as
/// (date, time, target, level, message). The plugin swaps level and target
/// once given a timezone strategy, so lines from before then have them the
/// other way round.
fn parse(line: &str) -> Option<(&str, &str, &str, &str, &str)> {
    let mut rest = line;
    let mut field = || {
        let inner = rest.strip_prefix('[')?;
        let end = inner.find(']')?;
        rest = &inner[end + 1..];
        Some(&inner[..end])
    };
    let (date, time, a, b) = (field()?, field()?, field()?, field()?);
    let (target, level) = if LEVELS.contains(&a) { (b, a) } else { (a, b) };
    Some((date, time, target, level, rest.trim_start()))
}

/// Which program wrote it: a relayed sidecar line names its own, the rest
/// come from the app or one of its plugins.
fn source<'a>(target: &str, message: &'a str) -> (String, &'a str) {
    for name in ["backend", "watcher"] {
        if let Some(msg) = message.strip_prefix(&format!("[{name}] ")) {
            // The helper relays the elevated indexer's lines.
            return match msg.strip_prefix("[indexer] ") {
                Some(msg) => ("indexer".into(), msg),
                None => (name.into(), msg),
            };
        }
    }
    let crate_name = target.split("::").next().unwrap_or(target);
    let source = match crate_name {
        "better_search_lib" => "app",
        other => other.strip_prefix("tauri_plugin_").unwrap_or(other),
    };
    (source.into(), message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entries() {
        assert_eq!(
            parse("[2026-10-27][07:43:28][better_search_lib][WARN] [backend] [indexer] Skipping D: access denied"),
            Some(("2026-10-27", "07:43:28", "better_search_lib", "WARN", "[backend] [indexer] Skipping D: access denied"))
        );
        assert_eq!(
            parse("[2026-10-27][07:43:28][ERROR][better_search_lib::logs] [watcher] x"),
            Some(("2026-10-27", "07:43:28", "better_search_lib::logs", "ERROR", "[watcher] x"))
        );
        assert_eq!(parse("  a continued line"), None);
    }

    #[test]
    fn names_the_source() {
        assert_eq!(source("better_search_lib", "[backend] [indexer] x"), ("indexer".into(), "x"));
        assert_eq!(source("better_search_lib", "[watcher] Watch C:: x"), ("watcher".into(), "Watch C:: x"));
        assert_eq!(source("better_search_lib", "Backend exited"), ("app".into(), "Backend exited"));
        assert_eq!(source("tauri_plugin_updater::updater", "x"), ("updater".into(), "x"));
    }
}
