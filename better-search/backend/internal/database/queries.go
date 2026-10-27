package database

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const fileColumns = `f.id, f.parent_id, f.name, f.is_dir, f.size, f.modified_at, f.open_count, f.last_opened`

// SearchNames finds files whose names contain every term, the best limit of
// them first (see rank.go). Terms of 3+ characters use the trigram index;
// trigram MATCH can't see substrings under 3 characters, so shorter terms
// filter the matches with LIKE. When every term is short, names must start
// with the first one: a substring scan of every name takes ~0.5 s on a
// million files, a prefix lookup is instant. Cancelling ctx stops the query
// where it is.
func (d *DB) SearchNames(ctx context.Context, query string, terms []string, limit int) ([]File, error) {
	if limit <= 0 {
		return nil, nil
	}
	var long, short []string
	for _, t := range terms {
		if utf8.RuneCountInString(t) >= 3 {
			long = append(long, t)
		} else {
			short = append(short, t)
		}
	}

	// Every match is read to be ranked, and the driver's cost is per column:
	// only what ranking needs, the usage and folder flag in one number. The
	// winners' other fields are read after (fillFiles).
	var q strings.Builder
	var args []any
	q.WriteString("SELECT f.id, f.name, f.open_count << 1 | f.is_dir, coalesce(f.last_opened, 0)")
	if len(long) > 0 {
		phrases := make([]string, len(long))
		for i, t := range long {
			phrases[i] = `"` + strings.ReplaceAll(t, `"`, `""`) + `"`
		}
		q.WriteString(" FROM files_fts JOIN files f ON f.id = files_fts.rowid WHERE files_fts MATCH ?")
		args = append(args, strings.Join(phrases, " "))
	} else {
		lo := strings.ToLower(short[0])
		q.WriteString(" FROM files f WHERE f.name >= ? COLLATE NOCASE AND f.name < ? COLLATE NOCASE")
		args = append(args, lo, prefixEnd(lo))
		short = short[1:]
	}
	for _, t := range short {
		q.WriteString(` AND f.name LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(t)+"%")
	}

	rows, err := d.sql.QueryContext(ctx, q.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	defer rows.Close()

	r := newRanker(query)
	top := make(topN, 0, min(limit, 1024)) // grows past it only for a huge limit with that many matches
	for rows.Next() {
		var f File
		var usage int64
		if err := rows.Scan(&f.ID, &f.Name, &usage, &f.LastOpened); err != nil {
			return nil, err
		}
		f.OpenCount, f.IsDir = usage>>1, usage&1 != 0
		top.add(r.rank(f), limit)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	files := top.files()
	return files, d.fillFiles(ctx, files)
}

const fillSQL = `SELECT id, parent_id, size, modified_at FROM files WHERE id IN (SELECT value FROM json_each(?))`

// fillFiles reads the fields SearchNames doesn't rank by.
func (d *DB) fillFiles(ctx context.Context, files []File) error {
	if len(files) == 0 {
		return nil
	}
	ids := []byte{'['}
	at := make(map[int64]int, len(files))
	for i, f := range files {
		if i > 0 {
			ids = append(ids, ',')
		}
		ids = strconv.AppendInt(ids, f.ID, 10)
		at[f.ID] = i
	}
	ids = append(ids, ']')
	s, err := d.prepared(fillSQL)
	if err != nil {
		return err
	}
	rows, err := s.QueryContext(ctx, string(ids))
	if err != nil {
		return fmt.Errorf("search: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var parent sql.NullInt64
		var size, mtime int64
		if err := rows.Scan(&id, &parent, &size, &mtime); err != nil {
			return err
		}
		f := &files[at[id]]
		f.ParentID, f.Size, f.ModifiedAt = parent.Int64, size, mtime
	}
	return rows.Err()
}

func scanFile(rows *sql.Rows) (File, error) {
	var f File
	var parent, lastOpened sql.NullInt64
	err := rows.Scan(&f.ID, &parent, &f.Name, &f.IsDir, &f.Size, &f.ModifiedAt, &f.OpenCount, &lastOpened)
	f.ParentID = parent.Int64
	f.LastOpened = lastOpened.Int64
	return f, err
}

// prefixEnd is the smallest string greater than every string starting with p.
func prefixEnd(p string) string {
	r := []rune(p)
	r[len(r)-1]++
	return string(r)
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

func escapeLike(s string) string {
	return likeEscaper.Replace(s)
}

// MarkOpened bumps the usage stats used for ranking.
func (d *DB) MarkOpened(id int64) error {
	_, err := d.sql.Exec(`UPDATE files SET open_count = open_count + 1, last_opened = ? WHERE id = ?`,
		time.Now().Unix(), id)
	return err
}

// Path builds the full path of a file, e.g. C:\Users\atharv\resume.pdf.
func (d *DB) Path(f File) (string, error) {
	paths, err := d.Paths(context.Background(), []File{f})
	if err != nil {
		return "", err
	}
	if paths[0] == "" {
		return "", fmt.Errorf("%s: its folders don't lead to a drive", f.Name)
	}
	return paths[0], nil
}

// ancestorsSQL reads every folder above the ids in a JSON array, in one go.
// UNION (not UNION ALL) drops rows it has already seen, so a loop of parent
// ids, which only a damaged index has, ends the walk instead of repeating.
const ancestorsSQL = `WITH RECURSIVE dirs (id, parent_id, name) AS (
	SELECT id, parent_id, name FROM files WHERE id IN (SELECT value FROM json_each(?))
	UNION
	SELECT f.id, f.parent_id, f.name FROM files f JOIN dirs ON f.id = dirs.parent_id)
SELECT id, parent_id, name FROM dirs`

// Paths builds the full path of each file, from one query for all their
// folders: a search's results share most of them. A file whose folders don't
// lead up to a drive root (a row missing, or a loop) gets "".
func (d *DB) Paths(ctx context.Context, files []File) ([]string, error) {
	ids := []byte{'['}
	for _, f := range files {
		if f.ParentID != 0 {
			if len(ids) > 1 {
				ids = append(ids, ',')
			}
			ids = strconv.AppendInt(ids, f.ParentID, 10)
		}
	}
	ids = append(ids, ']')

	s, err := d.prepared(ancestorsSQL)
	if err != nil {
		return nil, err
	}
	rows, err := s.QueryContext(ctx, string(ids))
	if err != nil {
		return nil, fmt.Errorf("folders: %w", err)
	}
	defer rows.Close()
	type dir struct {
		parent sql.NullInt64
		name   string
	}
	dirs := map[int64]dir{}
	for rows.Next() {
		var id int64
		var r dir
		if err := rows.Scan(&id, &r.parent, &r.name); err != nil {
			return nil, err
		}
		dirs[id] = r
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Folder id -> full path, "" for one that doesn't reach a root.
	built := map[int64]string{}
	var dirPath func(id int64) string
	dirPath = func(id int64) string {
		if p, ok := built[id]; ok {
			return p
		}
		built[id] = "" // until it's known: a loop back to here fails
		r, ok := dirs[id]
		var p string
		switch {
		case !ok:
		case !r.parent.Valid:
			p = r.name + `\`
		default:
			if parent := dirPath(r.parent.Int64); parent != "" {
				p = joinPath(parent, r.name)
			}
		}
		built[id] = p
		return p
	}

	out := make([]string, len(files))
	for i, f := range files {
		if f.ParentID == 0 {
			out[i] = f.Name + `\`
		} else if dir := dirPath(f.ParentID); dir != "" {
			out[i] = joinPath(dir, f.Name)
		}
	}
	return out, nil
}

func joinPath(dir, name string) string {
	if strings.HasSuffix(dir, `\`) {
		return dir + name
	}
	return dir + `\` + name
}
