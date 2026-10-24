package database

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

const fileColumns = `f.id, f.parent_id, f.name, f.is_dir, f.size, f.modified_at, f.open_count, f.last_opened`

// exactName matches a name equal to the query, with or without its extension
// ("resume" matches Resume.pdf). Args: query, query + ".%", query length.
const exactName = `(f.name = ? COLLATE NOCASE
  OR (f.name LIKE ? ESCAPE '\' AND instr(substr(f.name, ? + 2), '.') = 0))`

// Ranking by kind first: an exact file, then apps (.exe) starting with the
// query, then shortcuts (.lnk) and folders, then other files. Within each:
// exact name, the files the user opens most and most recently, names
// starting with the query, names with a word starting with it (after a
// space, dot, underscore or dash), then shorter names.
const rankOrder = `
ORDER BY CASE
           WHEN f.is_dir = 1 OR f.name LIKE '%.lnk' THEN 2
           WHEN ` + exactName + ` THEN 0
           WHEN f.name LIKE '%.exe' AND f.name LIKE ? ESCAPE '\' THEN 1
           ELSE 3
         END,
         ` + exactName + ` DESC,
         f.open_count DESC,
         f.last_opened DESC,
         CASE
           WHEN f.name LIKE ? ESCAPE '\' THEN 0
           WHEN f.name LIKE ? ESCAPE '\' OR f.name LIKE ? ESCAPE '\'
             OR f.name LIKE ? ESCAPE '\' OR f.name LIKE ? ESCAPE '\' THEN 1
           ELSE 2
         END,
         length(f.name),
         f.name`

// SearchNames finds files whose names contain every term. Terms of 3+
// characters use the trigram index; trigram MATCH can't see substrings under
// 3 characters, so shorter terms filter the matches with LIKE. When every
// term is short, names must start with the first one: a substring scan of
// every name takes ~0.5 s on a million files, a prefix lookup is instant.
func (d *DB) SearchNames(query string, terms []string, limit int) ([]File, error) {
	d.RefreshTree()

	var long, short []string
	for _, t := range terms {
		if len([]rune(t)) >= 3 {
			long = append(long, t)
		} else {
			short = append(short, t)
		}
	}

	var q strings.Builder
	var args []any
	q.WriteString("SELECT " + fileColumns)
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
	q.WriteString(rankOrder + " LIMIT ?")
	esc := escapeLike(query)
	exact := []any{query, esc + ".%", len([]rune(query))}
	args = append(args, exact...)
	args = append(args, esc+"%")
	args = append(args, exact...)
	args = append(args, esc+"%", "% "+esc+"%", "%."+esc+"%", `%\_`+esc+"%", "%-"+esc+"%", limit)

	rows, err := d.sql.Query(q.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	defer rows.Close()

	var out []File
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
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

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// MarkOpened bumps the usage stats used for ranking.
func (d *DB) MarkOpened(id int64) error {
	_, err := d.sql.Exec(`UPDATE files SET open_count = open_count + 1, last_opened = ? WHERE id = ?`,
		time.Now().Unix(), id)
	return err
}

// Path builds the full path of a file, e.g. C:\Users\atharv\resume.pdf.
func (d *DB) Path(f File) (string, error) {
	if f.ParentID == 0 {
		return f.Name + `\`, nil
	}
	dir, err := d.dirPath(f.ParentID, 0)
	if err != nil {
		return "", err
	}
	return joinPath(dir, f.Name), nil
}

const maxDirCache = 200_000

func (d *DB) dirPath(id int64, depth int) (string, error) {
	if depth > 1024 {
		return "", fmt.Errorf("folder %d: parent chain too deep (loop?)", id)
	}

	d.dirMu.Lock()
	p, ok := d.dirCache[id]
	d.dirMu.Unlock()
	if ok {
		return p, nil
	}

	var parent sql.NullInt64
	var name string
	if err := d.sql.QueryRow(`SELECT parent_id, name FROM files WHERE id = ?`, id).Scan(&parent, &name); err != nil {
		return "", fmt.Errorf("folder %d: %w", id, err)
	}
	if !parent.Valid {
		p = name + `\`
	} else {
		dir, err := d.dirPath(parent.Int64, depth+1)
		if err != nil {
			return "", err
		}
		p = joinPath(dir, name)
	}

	d.dirMu.Lock()
	if len(d.dirCache) >= maxDirCache {
		d.dirCache = make(map[int64]string)
	}
	d.dirCache[id] = p
	d.dirMu.Unlock()
	return p, nil
}

// ClearCache forgets cached folder paths, e.g. after another process rebuilt the index.
func (d *DB) ClearCache() {
	d.dirMu.Lock()
	d.dirCache = make(map[int64]string)
	d.dirMu.Unlock()
}

func joinPath(dir, name string) string {
	if strings.HasSuffix(dir, `\`) {
		return dir + name
	}
	return dir + `\` + name
}
