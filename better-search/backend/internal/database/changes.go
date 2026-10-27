package database

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"
)

// LookupVolume returns the number assigned to an NTFS volume by a full index,
// or false if that volume was never indexed. Unlike VolumeIndex it assigns
// nothing.
func (d *DB) LookupVolume(serial uint64) (int64, bool, error) {
	v, ok, err := d.meta("volume_index:" + strconv.FormatUint(serial, 16))
	if err != nil || !ok {
		return 0, false, err
	}
	n, err := strconv.ParseInt(v, 10, 64)
	return n, err == nil, err
}

// MarkStale records that the watcher may have missed changes, so the index
// should be rebuilt. A full index clears it.
func (d *DB) MarkStale() error { return d.setMeta(d.sql, "stale", "1") }

// Stale is true if changes may have been missed since the last full index.
func (d *DB) Stale() bool {
	n, _ := d.metaInt("stale")
	return n == 1
}

// Changes applies single-file additions, updates and removals, as reported by
// the filesystem watcher, in one transaction.
type Changes struct {
	tx *sql.Tx
	// A batch runs the same few statements once or more per path, so each is
	// prepared once. The transaction closes them when it ends.
	stmts map[string]*sql.Stmt
}

func (d *DB) BeginChanges() (*Changes, error) {
	tx, err := d.sql.Begin()
	if err != nil {
		return nil, err
	}
	// Take the write lock now: a read that turns into a write later fails
	// at once if another writer got in between, instead of waiting.
	if _, err := tx.Exec(`UPDATE meta SET value = value WHERE key = 'schema_version'`); err != nil {
		tx.Rollback()
		return nil, fmt.Errorf("lock index: %w", err)
	}
	return &Changes{tx: tx, stmts: map[string]*sql.Stmt{}}, nil
}

func (c *Changes) stmt(q string) (*sql.Stmt, error) {
	if s := c.stmts[q]; s != nil {
		return s, nil
	}
	s, err := c.tx.Prepare(q)
	if err != nil {
		return nil, err
	}
	c.stmts[q] = s
	return s, nil
}

// row is a QueryRow on a prepared statement, or the error preparing it.
type row struct {
	r   *sql.Row
	err error
}

func (r row) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	return r.r.Scan(dest...)
}

func (c *Changes) queryRow(q string, args ...any) row {
	s, err := c.stmt(q)
	if err != nil {
		return row{err: err}
	}
	return row{r: s.QueryRow(args...)}
}

func (c *Changes) query(q string, args ...any) (*sql.Rows, error) {
	s, err := c.stmt(q)
	if err != nil {
		return nil, err
	}
	return s.Query(args...)
}

func (c *Changes) exec(q string, args ...any) (sql.Result, error) {
	s, err := c.stmt(q)
	if err != nil {
		return nil, err
	}
	return s.Exec(args...)
}

// HasDir reports whether the index has a folder with this id.
func (c *Changes) HasDir(id int64) (bool, error) {
	var one int
	err := c.queryRow(`SELECT 1 FROM files WHERE id = ? AND is_dir = 1`, id).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// FindByPath returns the id of the row for a full path like C:\Users\me\a.txt,
// walking down one folder at a time.
func (c *Changes) FindByPath(path string) (int64, bool, error) {
	parts := strings.Split(strings.Trim(path, `\`), `\`)
	var id int64
	for i, name := range parts {
		var err error
		if i == 0 {
			err = c.queryRow(`SELECT id FROM files WHERE parent_id IS NULL AND name = ? COLLATE NOCASE`, name).Scan(&id)
		} else {
			// Exact first: that can use the (parent_id, name) index.
			err = c.queryRow(`SELECT id FROM files WHERE parent_id = ? AND name = ?`, id, name).Scan(&id)
			if err == sql.ErrNoRows {
				err = c.queryRow(`SELECT id FROM files WHERE parent_id = ? AND name = ? COLLATE NOCASE`, id, name).Scan(&id)
			}
		}
		if err == sql.ErrNoRows {
			return 0, false, nil
		}
		if err != nil {
			return 0, false, err
		}
	}
	return id, true, nil
}

// Upsert adds a file or brings its row up to date, keeping its usage stats.
// It reports whether the row already existed.
func (c *Changes) Upsert(f File) (bool, error) {
	var parent sql.NullInt64
	var name string
	var isDir bool
	var size, mtime int64
	err := c.queryRow(`SELECT parent_id, name, is_dir, size, modified_at FROM files WHERE id = ?`, f.ID).
		Scan(&parent, &name, &isDir, &size, &mtime)
	existed := err == nil
	if err != nil && err != sql.ErrNoRows {
		return false, err
	}
	if existed && parent.Int64 == f.ParentID && name == f.Name && isDir == f.IsDir && size == f.Size && mtime == f.ModifiedAt {
		return true, nil
	}

	// What the index holds inside a folder row is out of date when the row's
	// record now belongs to a file (Windows reuses a deleted entry's number),
	// or when the folder would end up below itself, which can't happen on
	// disk. Kept, those rows would point up into a loop that no path leads
	// out of, and the watcher puts back whatever of them still exists.
	if existed && isDir {
		stale := !f.IsDir
		if !stale && parent.Int64 != f.ParentID && f.ParentID != 0 {
			if stale, err = c.isAncestor(f.ID, f.ParentID); err != nil {
				return existed, err
			}
		}
		if stale {
			if err := c.deleteInside(f.ID); err != nil {
				return existed, err
			}
		}
	}

	// ParentID 0 means no parent (a drive root), stored as NULL.
	var newParent any
	if f.ParentID != 0 {
		newParent = f.ParentID
	}

	// Another row already has this name in this folder, e.g. a file replaced
	// by saving a temporary copy over it. It's gone, so drop it.
	rows, err := c.query(`SELECT id FROM files WHERE parent_id IS ? AND name = ? AND id != ?`, newParent, f.Name, f.ID)
	if err != nil {
		return existed, err
	}
	var clashes []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return existed, err
		}
		clashes = append(clashes, id)
	}
	rows.Close()
	for _, id := range clashes {
		if err := c.DeleteTree(id); err != nil {
			return existed, err
		}
	}

	_, err = c.exec(`INSERT INTO files (id, parent_id, name, is_dir, size, modified_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name,
			is_dir = excluded.is_dir, size = excluded.size, modified_at = excluded.modified_at`,
		f.ID, newParent, f.Name, f.IsDir, f.Size, f.ModifiedAt)
	if err != nil {
		return existed, fmt.Errorf("upsert file: %w", err)
	}
	return existed, nil
}

// isAncestor reports whether row id is folder dir or any folder above it.
// UNION stops at a loop the index already has.
func (c *Changes) isAncestor(id, dir int64) (bool, error) {
	var n int
	err := c.queryRow(`WITH RECURSIVE up (id) AS (
			SELECT ? UNION SELECT f.parent_id FROM files f JOIN up ON f.id = up.id WHERE f.parent_id IS NOT NULL)
		SELECT count(*) FROM up WHERE id = ?`, dir, id).Scan(&n)
	return n > 0, err
}

// deleteInside removes everything inside a folder, but not the folder.
func (c *Changes) deleteInside(id int64) error {
	_, err := c.exec(`WITH RECURSIVE sub (id) AS (
			SELECT id FROM files WHERE parent_id = ? UNION SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id)
		DELETE FROM files WHERE id IN (SELECT id FROM sub)`, id)
	return err
}

// DeleteTree removes a row and, if it's a folder, everything inside it.
func (c *Changes) DeleteTree(id int64) error {
	var isDir bool
	if err := c.queryRow(`SELECT is_dir FROM files WHERE id = ?`, id).Scan(&isDir); err == sql.ErrNoRows {
		return nil
	} else if err != nil {
		return err
	}
	if !isDir {
		_, err := c.exec(`DELETE FROM files WHERE id = ?`, id)
		return err
	}
	// UNION, not UNION ALL: a loop in a damaged index would never end.
	_, err := c.exec(`WITH RECURSIVE sub (id) AS (
			SELECT ? UNION SELECT f.id FROM files f JOIN sub ON f.parent_id = sub.id)
		DELETE FROM files WHERE id IN (SELECT id FROM sub)`, id)
	return err
}

func (c *Changes) Commit() error { return c.tx.Commit() }

func (c *Changes) Rollback() { c.tx.Rollback() }

// SetMtime records a folder's modified time once its contents have been checked.
func (c *Changes) SetMtime(id, mtime int64) error {
	_, err := c.exec(`UPDATE files SET modified_at = ? WHERE id = ?`, mtime, id)
	return err
}

// Child is what the index holds about one entry of a folder.
type Child struct {
	ID    int64
	IsDir bool
	Size  int64
	Mtime int64
}

// Children are the entries the index holds for a folder, by name.
func (d *DB) Children(parentID int64) (map[string]Child, error) {
	s, err := d.prepared(`SELECT id, name, is_dir, size, modified_at FROM files WHERE parent_id = ?`)
	if err != nil {
		return nil, err
	}
	rows, err := s.Query(parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Child{}
	for rows.Next() {
		var name string
		var c Child
		if err := rows.Scan(&c.ID, &name, &c.IsDir, &c.Size, &c.Mtime); err != nil {
			return nil, err
		}
		out[name] = c
	}
	return out, rows.Err()
}

// ChildDir is a folder inside another, as the index has it.
type ChildDir struct {
	ID    int64
	Name  string
	Mtime int64
}

func (d *DB) ChildDirs(parentID int64) ([]ChildDir, error) {
	s, err := d.prepared(`SELECT id, name, modified_at FROM files WHERE parent_id = ? AND is_dir = 1`)
	if err != nil {
		return nil, err
	}
	rows, err := s.Query(parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChildDir
	for rows.Next() {
		var c ChildDir
		if err := rows.Scan(&c.ID, &c.Name, &c.Mtime); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Dir returns a folder's modified time as indexed, and whether it's indexed.
func (d *DB) Dir(id int64) (int64, bool) {
	var m int64
	err := d.sql.QueryRow(`SELECT modified_at FROM files WHERE id = ? AND is_dir = 1`, id).Scan(&m)
	return m, err == nil
}

// Root returns the id and modified time of a drive's root folder, like "C:".
func (d *DB) Root(drive string) (int64, int64, bool) {
	var id, m int64
	err := d.sql.QueryRow(`SELECT id, modified_at FROM files WHERE parent_id IS NULL AND name = ? COLLATE NOCASE`, drive).Scan(&id, &m)
	return id, m, err == nil
}
