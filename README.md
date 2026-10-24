# Better Search

A fast file search for Windows. Press **Alt+S** anywhere, type part of a file name, and press **Enter** to open it.

Better Search reads your drives' file list once and keeps it up to date in the background. Searching never scans your disk, so results appear while you type, and the app uses about 10–20 MB of RAM while it waits in the background.

## Features

- **Instant file search.** Finds any file or folder whose name contains what you typed, on every NTFS drive. Several words narrow the search (`invoice 2024`).
- **Smart ranking.** Exact names come first, then apps, shortcuts and folders, then other files. Files you open often rise to the top.
- **Previews.** A small preview of the highlighted result: thumbnails of photos, videos, PDFs and Office files, the start of text and code files, and what's inside folders.
- **Type filters.** Show only folders, documents, images, videos, audio, code, archives or apps.
- **Web search.** Start with `/` (`/ weather tomorrow`) to search the web in the browser of your choice, using Google, Bing, DuckDuckGo, Brave or your own search URL. With your own API key for Exa, Firecrawl, TinyFish or Context.dev, results show right in the search window.
- **Always up to date.** A watcher applies file changes as they happen, and on start-up it catches up on anything that changed while the app was closed.
- **Recent searches** under the empty search box (optional).
- **Stays out of the way.** Runs in the background, can start with Windows, and only one copy ever runs.

## Using it

| Key | Action |
|---|---|
| **Alt+S** | Open or close the search (you can change it in Settings) |
| **↑ / ↓** | Move through the results |
| **Enter** | Open the highlighted result |
| **Ctrl+Enter** | Show it in File Explorer instead (you can swap these two in Settings) |
| **Tab / Shift+Tab** | Cycle the type filters; in web search, cycle the browser |
| **Esc** | Close the search |
| `/` + text | Search the web |

The first time you run it, Better Search asks for administrator permission to read your drives' file list. That takes about ten seconds. Normal use after that needs no special permission.

### Settings

Open Settings with the gear icon in the search bar. There you can:

- change the shortcut, and choose whether the app starts with Windows;
- choose how many results to show, whether to show previews, and whether to remember recent searches;
- leave out drives or folders from the index, or rebuild it;
- pick the web search engine and browser, and add search provider API keys.

## Performance

Measured on a release build with an index of 213,000 files:

| | Result |
|---|---|
| RAM while in the background | 9–17 MB |
| RAM while searching (with previews) | about 105 MB |
| Alt+S until the window shows | about 30 ms |
| Typing until results show | 120–170 ms, including a deliberate 100 ms pause while you type |
| Full index of a drive (2 million file records) | about 10 seconds |

## Privacy

Everything stays on your PC. The file index is a local database, and file names are never sent anywhere.

The only times the app goes online:
- **Web searches you start.** These go to your browser, or to the provider whose API key you added.
- **Website icons** for web results. These are fetched from each website directly, not through a third-party icon service.

API keys are stored in Windows Credential Manager.

## How it works

Better Search is a [Tauri](https://tauri.app) app: a Rust shell with a React interface drawn by WebView2. Small Go programs do the indexing and searching against a SQLite database.

```text
                 Better Search (Rust shell)
                 ├─ search window and Settings (React, in WebView2)
                 ├─ icons, previews and thumbnails (Windows Shell)
                 │
   JSON lines    │
   over stdin/   ├─ Search helper (Go) ───── searches ────► SQLite index
   stdout        │      └─ starts as admin: Indexer (Go) ── builds ──►    (FTS5 trigram)
                 └─ File watcher (Go) ────── updates ─────►
```

- **Indexer.** Reads each NTFS drive's Master File Table directly. That's far faster than walking folders, but it needs administrator rights, so it runs as its own short-lived program behind a UAC prompt. It skips caches and build folders (such as `node_modules`, `.git`, browser caches and `WinSxS`), plus any folders you exclude.
- **Search helper.** Answers searches with a trigram full-text index, so it can find any part of a name. It frees its memory whenever the window is hidden.
- **File watcher.** Windows tells it about each change (`ReadDirectoryChangesW`), so it uses no CPU between changes. On start-up it checks folder modification times to pick up changes made while the app was closed.

### Processes

In Task Manager, the app shows as:

| Name | Program | What it does |
|---|---|---|
| Better Search | `better-search.exe` | The app itself |
| Better Search: Search helper | `better-search-helper.exe` | Answers searches |
| Better Search: File watcher | `better-search-watcher.exe` | Keeps the index up to date |
| Better Search: Indexer | `better-search-indexer.exe` | Builds the full index; runs only while indexing |
| Microsoft Edge WebView2 | `msedgewebview2.exe` | Draws the window (several processes) |

### Where it keeps its files

| What | Where |
|---|---|
| File index | `%LOCALAPPDATA%\better-search\index.db` |
| Logs | `%LOCALAPPDATA%\better-search\logs\better-search.log` |
| Settings and recent searches | `%APPDATA%\better-search\` |
| Search provider API keys | Windows Credential Manager |

## Building from source

### Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org) 20 or newer
- [Rust](https://rustup.rs) (stable)
- [Go](https://go.dev) 1.26 or newer
- The [Tauri prerequisites for Windows](https://tauri.app/start/prerequisites/): Microsoft C++ Build Tools and the WebView2 runtime (built into Windows 11)

### Steps

```powershell
cd better-search
npm install

# Build the three Go programs into src-tauri\binaries.
# Run this again whenever you change code under backend\.
powershell -File backend\scripts\build-backend.ps1

# Run in development, with live reload of the interface
npm run tauri dev

# Or build the release app and installer (in src-tauri\target\release\bundle)
npm run tauri build
```

### Tests

```powershell
cd better-search\backend
go test ./...
```

The repository also has two benchmarks. They skip themselves unless you turn them on:

```powershell
# Search speed, against a copy of a real index
$env:BETTER_SEARCH_BENCH_DB = "C:\path\to\copy\index.db"
go test ./internal/search -bench .

# Full-index memory and speed, on a synthetic 2-million-record drive
$env:BETTER_SEARCH_BENCH_INDEX = "1"
go test ./internal/indexer -run IndexBench -v
```

## Project layout

```text
better-search/
├── src/                     React interface
│   ├── App.tsx              the search window
│   ├── settings/            the Settings window
│   ├── onboarding/          the first-run screen
│   ├── components/          results, previews, search box, menus
│   ├── lib/                 settings, backend client, icons
│   └── assets/icons/        Phosphor icons, as SVG files
├── src-tauri/               Rust shell
│   ├── src/lib.rs           windows, shortcut, sidecars, icons and previews
│   ├── src/web_search.rs    web search providers and favicons
│   ├── src/settings.rs      settings file and drive list
│   └── binaries/            the built Go programs (from build-backend.ps1)
└── backend/                 Go programs
    ├── cmd/helper/          Search helper
    ├── cmd/watcher/         File watcher
    ├── cmd/indexer/         Indexer
    └── internal/            database, indexer, watcher, search
```

### Adding an icon

Icons come from [Phosphor](https://phosphoricons.com). To add one:
1. Copy its SVG file from the `@phosphor-icons/core` package (`assets/<weight>/`) into `src/assets/icons/`, keeping its file name.
2. Add a line for it in `src/lib/phosphor.tsx`.

## Status

Early development (version 0.1.0). It works day to day, but settings, file formats and internals may still change. Self-updating only works once an update server is set up in `tauri.conf.json`.

No license has been chosen yet.
