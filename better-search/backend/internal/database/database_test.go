package database

import (
	"context"
	"path/filepath"
	"testing"
)

func openTest(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func load(t *testing.T, db *DB, files []File) {
	t.Helper()
	b, err := db.BeginBulk()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if err := b.Add(f); err != nil {
			t.Fatal(err)
		}
	}
	if err := b.Commit(); err != nil {
		t.Fatal(err)
	}
}

var tree = []File{
	{ID: 5, Name: "C:", IsDir: true},
	{ID: 20, ParentID: 5, Name: "Users", IsDir: true},
	{ID: 21, ParentID: 20, Name: "atharv", IsDir: true},
	{ID: 30, ParentID: 21, Name: "Resume.pdf", Size: 1000},
	{ID: 31, ParentID: 21, Name: "old_resume_draft.docx", Size: 2000},
	{ID: 32, ParentID: 21, Name: "ab.txt", Size: 3},
}

func names(t *testing.T, db *DB, q string, terms ...string) []string {
	t.Helper()
	if terms == nil {
		terms = []string{q}
	}
	files, err := db.SearchNames(context.Background(), q, terms, 10)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, f := range files {
		out = append(out, f.Name)
	}
	return out
}

func TestSearchAndPath(t *testing.T) {
	db := openTest(t)
	load(t, db, tree)

	got := names(t, db, "resum")
	if len(got) != 2 || got[0] != "Resume.pdf" {
		t.Fatalf("resum: got %v, want Resume.pdf first", got)
	}
	if got := names(t, db, "ab"); len(got) != 1 || got[0] != "ab.txt" {
		t.Fatalf("short query: got %v", got)
	}
	// Short queries match the start of the name only, ignoring case.
	if got := names(t, db, "RE"); len(got) != 1 || got[0] != "Resume.pdf" {
		t.Fatalf("short prefix query: got %v", got)
	}
	// A short term next to a long one still filters by substring.
	if got := names(t, db, "resume dr", "resume", "dr"); len(got) != 1 || got[0] != "old_resume_draft.docx" {
		t.Fatalf("mixed terms: got %v", got)
	}
	if got := names(t, db, "resume draft", "resume", "draft"); len(got) != 1 || got[0] != "old_resume_draft.docx" {
		t.Fatalf("multi-term: got %v", got)
	}
	if got := names(t, db, `100%_"x`); len(got) != 0 {
		t.Fatalf("special chars: got %v", got)
	}

	p, err := db.Path(File{ParentID: 21, Name: "Resume.pdf"})
	if err != nil || p != `C:\Users\atharv\Resume.pdf` {
		t.Fatalf("path: got %q, %v", p, err)
	}
	if p, _ := db.Path(File{Name: "C:"}); p != `C:\` {
		t.Fatalf("root path: got %q", p)
	}
}

func TestRankByKind(t *testing.T) {
	db := openTest(t)
	load(t, db, []File{
		{ID: 5, Name: "C:", IsDir: true},
		{ID: 40, ParentID: 5, Name: "spotify_cache.dat"},
		{ID: 41, ParentID: 5, Name: "Spotify.lnk"},
		{ID: 42, ParentID: 5, Name: "Spotify", IsDir: true},
		{ID: 43, ParentID: 5, Name: "SpotifyLauncher.exe"},
		{ID: 44, ParentID: 5, Name: "Spotify.exe"},
	})
	// Exact file and shortcuts, then apps, then folders, then other files.
	want := []string{"Spotify.exe", "Spotify.lnk", "SpotifyLauncher.exe", "Spotify", "spotify_cache.dat"}
	got := names(t, db, "spotify")
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestReindexKeepsUsageAndFTS(t *testing.T) {
	db := openTest(t)
	load(t, db, tree)
	if err := db.MarkOpened(31); err != nil {
		t.Fatal(err)
	}
	if got := names(t, db, "resum"); got[0] != "old_resume_draft.docx" {
		t.Fatalf("opened file should rank first, got %v", got)
	}

	// Re-index without ab.txt: usage kept, removed file gone from search.
	load(t, db, tree[:5])
	if got := names(t, db, "resum"); got[0] != "old_resume_draft.docx" {
		t.Fatalf("usage lost after reindex, got %v", got)
	}
	if got := names(t, db, "ab.t"); len(got) != 0 {
		t.Fatalf("deleted file still searchable: %v", got)
	}
	if n, _ := db.FileCount(); n != 5 {
		t.Fatalf("file_count = %d", n)
	}

	// Triggers are back after the bulk load: single-row writes stay in sync.
	if _, err := db.sql.Exec(`UPDATE files SET name = 'cv.pdf' WHERE id = 30`); err != nil {
		t.Fatal(err)
	}
	if got := names(t, db, "cv.p"); len(got) != 1 {
		t.Fatalf("rename not reflected in FTS: %v", got)
	}
}

func TestVolumeIndexStable(t *testing.T) {
	db := openTest(t)
	a, _ := db.VolumeIndex(0xAAAA)
	b, _ := db.VolumeIndex(0xBBBB)
	a2, _ := db.VolumeIndex(0xAAAA)
	if a != 0 || b != 1 || a2 != 0 {
		t.Fatalf("got %d %d %d", a, b, a2)
	}
}

// A full index loads without the unique (parent, name) index, so a duplicate
// name in a folder must be dropped at the end, keeping the first row, and the
// index must be back for the watcher's upserts.
func TestBulkDropsDuplicateNames(t *testing.T) {
	db := openTest(t)
	load(t, db, append(append([]File{}, tree...), File{ID: 40, ParentID: 21, Name: "Resume.pdf", Size: 9}))

	got, err := db.SearchNames(context.Background(), "resume.pdf", []string{"resume.pdf"}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != 30 {
		t.Fatalf("want only the first Resume.pdf (30), got %+v", got)
	}
	var indexes int
	if err := db.sql.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name IN ('files_parent_name', 'files_name_nocase', 'files_child_dirs')`).Scan(&indexes); err != nil || indexes != 3 {
		t.Fatalf("indexes after a full index: %d %v", indexes, err)
	}
}
