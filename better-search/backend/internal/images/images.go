// Package images keeps the text Windows' OCR read in the user's images, so
// content searches find screenshots and photos of notes by their words. It
// lives in a database of its own, images.db next to the search index, so
// deleting it gives all its space back without touching the index.
//
// The app's shell does the reading (Windows' OCR is a WinRT API): it asks
// Pending for the images that are new or changed, and hands the text back to
// Add.
package images

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"unicode"

	_ "modernc.org/sqlite"
)

const schemaSQL = `
CREATE TABLE IF NOT EXISTS images (
    id    INTEGER PRIMARY KEY,
    path  TEXT    NOT NULL UNIQUE,
    mtime INTEGER NOT NULL,          -- unix seconds, to tell when it changed
    size  INTEGER NOT NULL,
    text  TEXT    NOT NULL           -- "" when the image has no text: not read again
);
CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5 (
    text,
    content = 'images',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS images_ai AFTER INSERT ON images BEGIN
    INSERT INTO images_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS images_ad AFTER DELETE ON images BEGIN
    INSERT INTO images_fts (images_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE OF text ON images BEGIN
    INSERT INTO images_fts (images_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO images_fts (rowid, text) VALUES (new.id, new.text);
END;`

// Extensions read, those Windows decodes without extra codecs (webp and heic
// need the Store's extensions; reading fails without them, which is fine).
var extensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".bmp": true, ".gif": true,
	".tif": true, ".tiff": true, ".webp": true, ".heic": true,
}

const (
	// Smaller is an icon or a thumbnail, with no text worth reading.
	minSize = 4 << 10
	maxSize = 40 << 20
	// Windows' attributes for files that live in the cloud (OneDrive, Phone
	// Link): opening one downloads it, or fails with a dialog.
	attrOffline        = 0x1000
	attrRecallOnOpen   = 0x40000
	attrRecallOnAccess = 0x400000
	cloudOnly          = attrOffline | attrRecallOnOpen | attrRecallOnAccess
)

// Image is one image file: what Pending asks to be read, and with Text what
// Add stores.
type Image struct {
	Path  string `json:"path"`
	MTime int64  `json:"mtime"`
	Size  int64  `json:"size"`
	Text  string `json:"text,omitempty"`
}

// Stats is what the store holds.
type Stats struct {
	Exists   bool  `json:"exists"`
	Images   int64 `json:"images"`    // read, with text or not
	WithText int64 `json:"with_text"` // that had text
	Bytes    int64 `json:"bytes"`     // the database's files on disk
}

// Skip reports whether a path is left out, like search.Skip.
type Skip func(path string, isDir bool) bool

type Store struct {
	path string
	mu   sync.Mutex
	db   *sql.DB // nil until first needed, and after Close
}

// Path is where the store goes for the index at indexPath.
func Path(indexPath string) string {
	return filepath.Join(filepath.Dir(indexPath), "images.db")
}

func New(path string) *Store {
	return &Store{path: path}
}

// open returns the database, creating it if create; nil, nil when it doesn't
// exist and create is false (searching mustn't make an empty one).
func (s *Store) open(create bool) (*sql.DB, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		return s.db, nil
	}
	if !create {
		if _, err := os.Stat(s.path); errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
	}
	db, err := sql.Open("sqlite", s.path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("images: create schema: %w", err)
	}
	s.db = db
	return db, nil
}

// Close closes the database, giving back its memory. The next use opens it
// again.
func (s *Store) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		s.db.Close()
		s.db = nil
	}
}

// Delete removes the database and its files: image text isn't searched
// until images are read again.
func (s *Store) Delete() error {
	s.Close()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(s.path + suffix); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Pending walks folders for images and returns those not read yet or changed
// since, newest first (the screenshot just taken matters most). Images gone
// from the folders, or in a folder no longer listed, are forgotten.
func (s *Store) Pending(ctx context.Context, folders []string, skip Skip) ([]Image, error) {
	db, err := s.open(true)
	if err != nil {
		return nil, err
	}
	known := map[string][2]int64{} // path -> mtime, size
	rows, err := db.QueryContext(ctx, `SELECT path, mtime, size FROM images`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p string
		var m, z int64
		if err := rows.Scan(&p, &m, &z); err != nil {
			rows.Close()
			return nil, err
		}
		known[p] = [2]int64{m, z}
	}
	rows.Close()

	seen := map[string]bool{}
	var pending []Image
	for _, root := range folders {
		filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if err != nil {
				return nil // unreadable: skip it, carry on
			}
			if d.IsDir() {
				if path != root && (skip != nil && skip(path, true) || cloud(d)) {
					return filepath.SkipDir
				}
				return nil
			}
			if !extensions[strings.ToLower(filepath.Ext(path))] || seen[path] || (skip != nil && skip(path, false)) {
				return nil
			}
			info, err := d.Info()
			if err != nil || info.Size() < minSize || info.Size() > maxSize || cloud(d) {
				return nil
			}
			seen[path] = true
			img := Image{Path: path, MTime: info.ModTime().Unix(), Size: info.Size()}
			if k, ok := known[path]; !ok || k[0] != img.MTime || k[1] != img.Size {
				pending = append(pending, img)
			}
			return nil
		})
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	var gone []any
	for p := range known {
		if !seen[p] {
			gone = append(gone, p)
		}
	}
	if err := deletePaths(ctx, db, gone); err != nil {
		return nil, err
	}
	sort.Slice(pending, func(i, j int) bool { return pending[i].MTime > pending[j].MTime })
	return pending, nil
}

func deletePaths(ctx context.Context, db *sql.DB, paths []any) error {
	for len(paths) > 0 {
		n := min(len(paths), 500)
		q := `DELETE FROM images WHERE path IN (?` + strings.Repeat(",?", n-1) + `)`
		if _, err := db.ExecContext(ctx, q, paths[:n]...); err != nil {
			return err
		}
		paths = paths[n:]
	}
	return nil
}

// cloud reports whether a file or folder only lives in the cloud.
func cloud(d fs.DirEntry) bool {
	info, err := d.Info()
	if err != nil {
		return false
	}
	a, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return ok && a.FileAttributes&cloudOnly != 0
}

// Add stores what was read in images, replacing what an earlier read of the
// same path stored.
func (s *Store) Add(ctx context.Context, images []Image) error {
	if len(images) == 0 {
		return nil
	}
	db, err := s.open(true)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, img := range images {
		if _, err := tx.ExecContext(ctx, `INSERT INTO images (path, mtime, size, text) VALUES (?, ?, ?, ?)
			ON CONFLICT (path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, text = excluded.text`,
			img.Path, img.MTime, img.Size, strings.TrimSpace(img.Text)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Search returns the paths of up to limit images whose text has every word of
// query, each as a prefix, best match first; none when there's no store.
func (s *Store) Search(ctx context.Context, query string, limit int) ([]string, error) {
	match := matchQuery(query)
	if match == "" {
		return nil, nil
	}
	db, err := s.open(false)
	if db == nil || err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT i.path FROM images_fts JOIN images i ON i.id = images_fts.rowid
		WHERE images_fts MATCH ? ORDER BY bm25(images_fts) LIMIT ?`, match, limit)
	if err != nil {
		return nil, fmt.Errorf("images: search: %w", err)
	}
	defer rows.Close()
	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		paths = append(paths, p)
	}
	return paths, rows.Err()
}

// matchQuery is the FTS5 query for every word of query as a prefix: words
// split where the tokenizer splits them, so punctuation can't reach FTS5's
// own syntax.
func matchQuery(query string) string {
	var terms []string
	for _, w := range strings.FieldsFunc(query, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		terms = append(terms, `"`+w+`"*`)
		if len(terms) == 8 {
			break
		}
	}
	return strings.Join(terms, " AND ")
}

// Stats counts what's stored, without creating the store. It first moves
// what's been added from the write-ahead log into the database, which then
// shows its real size: the log holds a copy of every page written and grows
// to several times the text while images are being read.
func (s *Store) Stats(ctx context.Context) (Stats, error) {
	var st Stats
	if db, err := s.open(false); db != nil && err == nil {
		db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`)
	}
	for _, suffix := range []string{"", "-wal"} {
		if info, err := os.Stat(s.path + suffix); err == nil {
			st.Exists = true
			st.Bytes += info.Size()
		}
	}
	if !st.Exists {
		return st, nil
	}
	db, err := s.open(false)
	if db == nil || err != nil {
		return st, err
	}
	err = db.QueryRowContext(ctx, `SELECT count(*), count(*) FILTER (WHERE text <> '') FROM images`).Scan(&st.Images, &st.WithText)
	return st, err
}
