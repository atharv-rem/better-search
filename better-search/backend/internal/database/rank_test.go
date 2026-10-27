package database

import (
	"context"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

// The ORDER BY searches were ranked with before rank.go: the Go ranking must
// put matches in the same order.
const sqlExactName = `(f.name = ? COLLATE NOCASE
  OR (f.name LIKE ? ESCAPE '\' AND instr(substr(f.name, ? + 2), '.') = 0))`

const sqlRankOrder = `
ORDER BY CASE
           WHEN f.name LIKE '%.lnk' AND (f.name LIKE ? ESCAPE '\' OR f.name LIKE ? ESCAPE '\') THEN 0
           WHEN f.is_dir = 1 OR f.name LIKE '%.lnk' THEN 2
           WHEN ` + sqlExactName + ` THEN 0
           WHEN f.name LIKE '%.exe' AND f.name LIKE ? ESCAPE '\' THEN 1
           ELSE 3
         END,
         ` + sqlExactName + ` DESC,
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

func sqlRanked(t *testing.T, db *DB, query string, ids []int64) []string {
	t.Helper()
	list := make([]string, len(ids))
	for i, id := range ids {
		list[i] = strconv.FormatInt(id, 10)
	}
	esc := escapeLike(query)
	exact := []any{query, esc + ".%", utf8.RuneCountInString(query)}
	args := []any{"[" + strings.Join(list, ",") + "]", esc + "%", "% " + esc + "%"}
	args = append(args, exact...)
	args = append(args, esc+"%")
	args = append(args, exact...)
	args = append(args, esc+"%", "% "+esc+"%", "%."+esc+"%", `%\_`+esc+"%", "%-"+esc+"%")
	rows, err := db.sql.Query(`SELECT f.name FROM files f WHERE f.id IN (SELECT value FROM json_each(?))`+sqlRankOrder, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		out = append(out, name)
	}
	return out
}

func TestRankMatchesSQL(t *testing.T) {
	db := openTest(t)
	files := []File{
		{ID: 5, Name: "C:", IsDir: true},
		{ID: 20, ParentID: 5, Name: "Start Menu", IsDir: true},
		{ID: 21, ParentID: 5, Name: "Docs", IsDir: true},
	}
	names := []string{
		"Resume.pdf", "resume", "RESUME.DOCX", "resume.tar.gz", "Resume", "old_resume.pdf", "my-resume.txt",
		"cv.resume.bak", "Draft Resume.lnk", "Resume Builder.lnk", "resumes.lnk", "Resumer.exe", "ResumeTool.exe",
		"tool_resume.exe", "xresume", "Résumé.pdf", "RÉSUMÉ.pdf", "résumé", "Visual Studio Code.lnk",
		"Code.exe", "code", "Code", "vscode.exe", "Spotify.lnk", "Spotify.exe", "spotify_cache.dat", "a",
		"ab.txt", "A.lnk", "Apps", "e.p", "my file.txt", "My File", "100%_done.txt", "under_score", "re",
	}
	id := int64(100)
	for _, n := range names {
		for _, parent := range []int64{20, 21} {
			files = append(files, File{ID: id, ParentID: parent, Name: n, IsDir: !strings.Contains(n, ".") && id%3 == 0})
			id++
		}
	}
	load(t, db, files)
	for i, row := range []struct{ id, opens, at int64 }{{101, 3, 50}, {105, 3, 70}, {130, 1, 10}, {140, 1, 10}, {150, 9, 0}} {
		var at any = row.at
		if row.at == 0 {
			at = nil
		}
		if _, err := db.sql.Exec(`UPDATE files SET open_count = ?, last_opened = ? WHERE id = ?`, row.opens, at, row.id); err != nil {
			t.Fatal(i, err)
		}
	}

	for _, q := range []string{"resume", "RESUME", "res", "re", "a", "code", "spotify", "résumé", "RÉSUMÉ", "sum",
		"e.p", "my file", "100%_", "under", "s", "tool", "visual studio"} {
		terms := strings.Fields(q)
		all, err := db.SearchNames(context.Background(), q, terms, 1000)
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]int64, len(all))
		got := make([]string, len(all))
		for i, f := range all {
			ids[i], got[i] = f.ID, f.Name
		}
		want := sqlRanked(t, db, q, ids)
		if !slices.Equal(got, want) {
			t.Errorf("%q:\n got  %q\n want %q", q, got, want)
		}
		// A limit keeps the best, in order.
		if len(all) > 3 {
			top, err := db.SearchNames(context.Background(), q, terms, 3)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.EqualFunc(top, all[:3], func(a, b File) bool { return a.ID == b.ID }) {
				t.Errorf("%q limit 3: got %v, want the first 3 of %v", q, top, all[:3])
			}
		}
	}
}
