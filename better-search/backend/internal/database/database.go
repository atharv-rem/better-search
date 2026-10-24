package database

import (
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// v2: files_name_nocase index for short-query prefix search.
const schemaVersion = 2

//go:embed schema.sql
var schemaSQL string

// FTS sync triggers live outside schema.sql because a full index drops them,
// bulk-loads the files table, rebuilds files_fts once and recreates them.
const createTriggersSQL = `
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts (rowid, name) VALUES (new.id, new.name);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts (files_fts, rowid, name) VALUES ('delete', old.id, old.name);
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE OF name ON files BEGIN
    INSERT INTO files_fts (files_fts, rowid, name) VALUES ('delete', old.id, old.name);
    INSERT INTO files_fts (rowid, name) VALUES (new.id, new.name);
END;`

const dropTriggersSQL = `
DROP TRIGGER IF EXISTS files_ai;
DROP TRIGGER IF EXISTS files_ad;
DROP TRIGGER IF EXISTS files_au;`

// File is one row of the files table. ParentID 0 means "no parent" (a drive root).
type File struct {
	ID         int64
	ParentID   int64
	Name       string
	IsDir      bool
	Size       int64
	ModifiedAt int64
	OpenCount  int64
	LastOpened int64
}

type DB struct {
	sql *sql.DB

	// Folder id -> full path, so building result paths doesn't re-walk the tree.
	dirMu    sync.Mutex
	dirCache map[int64]string
	treeSeen int64 // meta tree_version the cache was last checked against
}

// DefaultPath is %LOCALAPPDATA%\better-search\index.db.
func DefaultPath() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base, _ = os.UserCacheDir()
	}
	return filepath.Join(base, "better-search", "index.db")
}

func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create database folder: %w", err)
	}

	dsn := path +
		"?_pragma=busy_timeout(10000)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=synchronous(NORMAL)" +
		"&_pragma=cache_size(-65536)" + // 64 MB page cache per connection
		"&_pragma=temp_store(MEMORY)"

	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}

	db := &DB{sql: conn, dirCache: make(map[int64]string)}
	if err := db.migrate(); err != nil {
		conn.Close()
		return nil, err
	}
	return db, nil
}

func (d *DB) Close() error {
	return d.sql.Close()
}

func (d *DB) migrate() error {
	// Check with a read first: an indexing process holds the write lock for
	// minutes, and reads are never blocked by it in WAL mode.
	var hasMeta bool
	if err := d.sql.QueryRow(`SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).Scan(&hasMeta); err != nil {
		return fmt.Errorf("read schema: %w", err)
	}
	if hasMeta {
		current, err := d.metaInt("schema_version")
		if err != nil {
			return err
		}
		if current == schemaVersion {
			return nil
		}
	}

	if _, err := d.sql.Exec(schemaSQL); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	if _, err := d.sql.Exec(createTriggersSQL); err != nil {
		return fmt.Errorf("create triggers: %w", err)
	}

	current, err := d.metaInt("schema_version")
	if err != nil {
		return err
	}
	if current > schemaVersion {
		return fmt.Errorf("database schema v%d is newer than this app (v%d)", current, schemaVersion)
	}
	// Future schema upgrades go here: if current < 2 { ... }
	return d.setMeta(d.sql, "schema_version", strconv.Itoa(schemaVersion))
}

type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func (d *DB) setMeta(ex execer, key, value string) error {
	_, err := ex.Exec(`INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

func (d *DB) meta(key string) (string, bool, error) {
	var v string
	err := d.sql.QueryRow(`SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return v, err == nil, err
}

func (d *DB) metaInt(key string) (int64, error) {
	v, ok, err := d.meta(key)
	if err != nil || !ok {
		return 0, err
	}
	return strconv.ParseInt(v, 10, 64)
}

// IndexedAt is when the last full index finished (unix seconds), or 0 if never.
func (d *DB) IndexedAt() (int64, error) {
	return d.metaInt("indexed_at")
}

// FileCount is the number of rows written by the last full index.
func (d *DB) FileCount() (int64, error) {
	return d.metaInt("file_count")
}

// VolumeIndex returns the stable small number for an NTFS volume (by serial
// number), assigning the next free one the first time a volume is seen.
func (d *DB) VolumeIndex(serial uint64) (int64, error) {
	key := "volume_index:" + strconv.FormatUint(serial, 16)
	if v, ok, err := d.meta(key); err != nil {
		return 0, err
	} else if ok {
		return strconv.ParseInt(v, 10, 64)
	}

	next, err := d.metaInt("next_volume_index")
	if err != nil {
		return 0, err
	}
	tx, err := d.sql.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err := d.setMeta(tx, key, strconv.FormatInt(next, 10)); err != nil {
		return 0, err
	}
	if err := d.setMeta(tx, "next_volume_index", strconv.FormatInt(next+1, 10)); err != nil {
		return 0, err
	}
	return next, tx.Commit()
}

// Bulk replaces the whole files table in one transaction. Searches keep
// seeing the old index until Commit.
type Bulk struct {
	db    *DB
	tx    *sql.Tx
	batch []File
	count int64
}

const bulkBatchRows = 500 // 8 params per row, well under SQLite's variable limit

func (d *DB) BeginBulk() (*Bulk, error) {
	tx, err := d.sql.Begin()
	if err != nil {
		return nil, err
	}
	steps := []string{
		dropTriggersSQL,
		// Carry usage stats over to the new index.
		`DROP TABLE IF EXISTS temp.keep_usage`,
		`CREATE TEMP TABLE keep_usage AS
			SELECT id, name, open_count, last_opened FROM files
			WHERE open_count > 0 OR last_opened IS NOT NULL`,
		`DELETE FROM files`,
	}
	for _, s := range steps {
		if _, err := tx.Exec(s); err != nil {
			tx.Rollback()
			return nil, fmt.Errorf("start bulk index: %w", err)
		}
	}
	return &Bulk{db: d, tx: tx, batch: make([]File, 0, bulkBatchRows)}, nil
}

func (b *Bulk) Add(f File) error {
	b.batch = append(b.batch, f)
	if len(b.batch) == bulkBatchRows {
		return b.flush()
	}
	return nil
}

func (b *Bulk) flush() error {
	if len(b.batch) == 0 {
		return nil
	}
	var q strings.Builder
	q.WriteString(`INSERT OR IGNORE INTO files (id, parent_id, name, is_dir, size, modified_at) VALUES `)
	args := make([]any, 0, len(b.batch)*6)
	for i, f := range b.batch {
		if i > 0 {
			q.WriteByte(',')
		}
		q.WriteString("(?,?,?,?,?,?)")
		var parent any
		if f.ParentID != 0 {
			parent = f.ParentID
		}
		args = append(args, f.ID, parent, f.Name, f.IsDir, f.Size, f.ModifiedAt)
	}
	if _, err := b.tx.Exec(q.String(), args...); err != nil {
		return fmt.Errorf("insert files: %w", err)
	}
	b.count += int64(len(b.batch))
	b.batch = b.batch[:0]
	return nil
}

func (b *Bulk) Commit() error {
	if err := b.flush(); err != nil {
		b.tx.Rollback()
		return err
	}
	steps := []string{
		`UPDATE files SET open_count = k.open_count, last_opened = k.last_opened
			FROM temp.keep_usage AS k
			WHERE files.id = k.id AND files.name = k.name`,
		`DROP TABLE temp.keep_usage`,
		`DELETE FROM meta WHERE key = 'stale'`, // a fresh index has nothing missed
		`INSERT INTO files_fts (files_fts) VALUES ('rebuild')`,
		createTriggersSQL,
	}
	for _, s := range steps {
		if _, err := b.tx.Exec(s); err != nil {
			b.tx.Rollback()
			return fmt.Errorf("finish bulk index: %w", err)
		}
	}
	if err := b.db.setMeta(b.tx, "indexed_at", strconv.FormatInt(time.Now().Unix(), 10)); err != nil {
		b.tx.Rollback()
		return err
	}
	if err := b.db.setMeta(b.tx, "file_count", strconv.FormatInt(b.count, 10)); err != nil {
		b.tx.Rollback()
		return err
	}
	if err := b.tx.Commit(); err != nil {
		return err
	}
	b.db.ClearCache()
	return nil
}

func (b *Bulk) Abort() {
	b.tx.Rollback()
}
