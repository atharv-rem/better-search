-- Key/value settings: schema version, volume ids, last index time.
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per file or folder. The full path is not stored; it is rebuilt by
-- walking parent_id up to the drive root (a row named "C:" with no parent).
--
-- id = (volume index << 32) | MFT record number, so the same file keeps the
-- same id across re-scans and NTFS change events map straight to a row.
CREATE TABLE IF NOT EXISTS files (
    id          INTEGER PRIMARY KEY,
    parent_id   INTEGER,
    name        TEXT    NOT NULL,
    is_dir      INTEGER NOT NULL DEFAULT 0,
    size        INTEGER NOT NULL DEFAULT 0,
    modified_at INTEGER NOT NULL DEFAULT 0,   -- unix seconds
    open_count  INTEGER NOT NULL DEFAULT 0,
    last_opened INTEGER                       -- unix seconds, NULL = never
);

-- Finds a file from its path one folder at a time, and stops duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS files_parent_name ON files (parent_id, name);

-- A folder's subfolders, for the catch-up walk: without it, listing them reads
-- every file row in the folder too. Holds folder rows only.
CREATE INDEX IF NOT EXISTS files_child_dirs ON files (parent_id, name, modified_at) WHERE is_dir = 1;

-- Prefix search for 1-2 character queries, which the trigram index can't answer.
CREATE INDEX IF NOT EXISTS files_name_nocase ON files (name COLLATE NOCASE);

-- Substring search on file names. Reads names from the files table
-- (content=files), so they are not stored twice.
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5 (
    name,
    content = 'files',
    content_rowid = 'id',
    tokenize = 'trigram'
);
