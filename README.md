# Better Search

A fast, lightweight Windows file search application built with **Tauri, Go, SQLite, and a modern web frontend**.

Better Search runs quietly in the background and provides an instant search interface when you press **`Alt + S`**. Instead of scanning your filesystem every time you search, Better Search maintains a local SQLite index of file metadata, allowing results to appear almost instantly.

## Features

* **Instant search** — Search indexed files without repeatedly scanning the filesystem.
* **Local indexing** — File metadata is stored in a local SQLite database.
* **Fast backend** — Go handles indexing, filesystem operations, and search logic.
* **Lightweight desktop app** — Tauri provides a small native application footprint.
* **Global keyboard shortcut** — Press `Alt + S` to open the search interface.
* **Background operation** — The application can remain running quietly in the system tray.
* **Incremental updates** — Filesystem changes can be detected and reflected in the index.
* **SQLite-powered search** — Fast local queries without requiring an external database.
* **Autostart support** — Optionally start Better Search automatically with Windows.
* **Window state persistence** — Preserve relevant window configuration between launches.
* **Single-instance protection** — Prevent multiple Better Search processes from running simultaneously.
* **Application updates** — Built-in updater support for distributing new versions.

## Architecture

Better Search is split into two main layers:

```text
┌──────────────────────────────────────────────┐
│                 Better Search                │
├──────────────────────────────────────────────┤
│                                              │
│   Tauri Desktop Application                  │
│   ┌──────────────────────────────────────┐   │
│   │ Frontend                             │   │
│   │                                      │   │
│   │ Search UI                            │   │
│   │ Results                              │   │
│   │ Keyboard interaction                 │   │
│   └──────────────────┬───────────────────┘   │
│                      │                       │
│                      ▼                       │
│   ┌──────────────────────────────────────┐   │
│   │ Tauri Layer                         │   │
│   │                                      │   │
│   │ Commands / Plugins / Window Control │   │
│   └──────────────────┬───────────────────┘   │
│                      │                       │
│                      ▼                       │
│   Go Backend                              │
│   ┌──────────────────────────────────────┐   │
│   │ File Indexer                         │   │
│   │ Search Engine                        │   │
│   │ Filesystem Watcher                   │   │
│   │ Database Layer                       │   │
│   └──────────────────┬───────────────────┘   │
│                      │                       │
│                      ▼                       │
│              SQLite Database                 │
│                                              │
└──────────────────────────────────────────────┘
```

### Why Tauri + Go?

**Tauri** is responsible for the desktop application layer and user interface, while **Go** handles the computationally intensive backend work.

This separation keeps the UI responsive while allowing the backend to efficiently handle:

* Filesystem traversal
* File indexing
* Filesystem change detection
* Database operations
* Search queries
* Metadata processing

## Project Structure

```text
better-search/
│
├── src/                         # Frontend application
│
├── src-tauri/                   # Tauri application
│   ├── src/
│   ├── capabilities/
│   ├── icons/
│   ├── tauri.conf.json
│   └── Cargo.toml
│
├── backend/                     # Go backend
│   ├── cmd/
│   ├── internal/
│   ├── go.mod
│   └── go.sum
│
├── package.json
├── package-lock.json
└── README.md
```

The exact structure may evolve as the project grows.

## Search Flow

When the user presses `Alt + S`:

```text
User presses Alt + S
        │
        ▼
Search window opens
        │
        ▼
User enters query
        │
        ▼
Frontend sends query
        │
        ▼
Go backend
        │
        ▼
SQLite search
        │
        ▼
Ranked results
        │
        ▼
Results displayed
```

The key design principle is that **search should not require a full filesystem scan**.

The filesystem is indexed ahead of time, so a normal search becomes primarily a database query rather than an expensive filesystem operation.

## Indexing

Better Search maintains an index containing file information such as:

```text
Path
Filename
Extension
Directory
Size
Created time
Modified time
Other searchable metadata
```

The initial index can scan the configured filesystem locations.

After the initial scan, filesystem changes can be detected using a filesystem watcher such as `fsnotify`.

Conceptually:

```text
Initial scan
     │
     ▼
Build SQLite index
     │
     ▼
Start filesystem watcher
     │
     ├── File created ──────► Add to index
     │
     ├── File modified ─────► Update index
     │
     ├── File renamed ──────► Update index
     │
     └── File deleted ──────► Remove from index
```

This allows the database to remain synchronized without repeatedly rebuilding the entire index.

## Technology Stack

### Desktop

* **Tauri 2**
* Rust
* Tauri plugins

### Backend

* **Go**
* Filesystem APIs
* `fsnotify`
* SQLite

### Database

* **SQLite**

SQLite is used because Better Search is a local desktop application and does not require a separate database server.

### Tauri Plugins

The project can use Tauri plugins for functionality such as:

* Shell integration
* Single-instance behavior
* SQLite access
* Application updates
* File uploads
* Window state persistence
* Autostart

## Requirements

Before running the project, install:

* Node.js
* npm
* Rust
* Tauri CLI
* Go

For Windows development, ensure the required Tauri Windows development dependencies are installed as described in the Tauri documentation.

## Getting Started

Clone the repository:

```bash
git clone <repository-url>
cd better-search
```

Install frontend dependencies:

```bash
npm install
```

Install Go dependencies:

```bash
cd backend
go mod download
cd ..
```

## Development

Start the Tauri development environment:

```bash
npm run tauri dev
```

The development application should launch with the frontend and Tauri environment connected to the backend.

If the Go backend is run independently during development:

```bash
cd backend
go run .
```

The exact backend entry point may differ depending on the final project structure.

## Building

Build the production application with:

```bash
npm run tauri build
```

Tauri will create the appropriate Windows application artifacts.

## Design Goals

Better Search is designed around several principles.

### 1. Speed

Search should feel instantaneous.

The application should avoid expensive operations during normal searches and instead rely on a continuously maintained local index.

### 2. Low Resource Usage

The application is intended to stay running in the background without consuming significant CPU or memory while idle.

Heavy work such as indexing should happen only when necessary.

### 3. Local-First

File information remains on the user's machine.

The core search functionality does not require sending filesystem information to a remote server.

### 4. Minimal UI

The primary interface is intentionally small.

The intended interaction is:

```text
Alt + S
   ↓
Type
   ↓
Find
   ↓
Open
```

The application should stay out of the user's way until it is needed.

## Planned Improvements

Potential future improvements include:

* Smarter result ranking
* Fuzzy filename matching
* Search filters
* File-type filters
* Folder-specific searches
* Recent searches
* Search history
* Content indexing
* Application indexing
* Better Windows integration
* Improved keyboard navigation
* Index performance optimizations
* Background indexing prioritization
* Configurable indexed locations
* Advanced search operators

## Performance Philosophy

The main performance goal is:

> **Do the expensive work once, then make searching cheap.**

Instead of:

```text
Search
  ↓
Scan filesystem
  ↓
Check thousands/millions of files
  ↓
Return results
```

Better Search aims for:

```text
Filesystem
    ↓
Background indexing
    ↓
SQLite
    ↓
Search
    ↓
Immediate results
```

This architecture makes the cost of a search largely independent of the total number of files on the system.

## Contributing

Contributions, bug reports, performance improvements, and feature ideas are welcome.

When contributing, keep the project's primary goals in mind:

* Fast
* Lightweight
* Local-first
* Reliable
* Simple

## License

This project is licensed under the terms specified in the repository's license file.

## Status

Better Search is currently under active development.

The architecture and APIs may change as indexing, search ranking, Windows integration, and the desktop experience continue to evolve.
