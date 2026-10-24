package indexer

import (
	"os"
	"path/filepath"
	"testing"

	"better-search/backend/internal/database"
)

func TestLoadOptions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	data := `{"shortcut":"Alt+S","indexing":{"excluded_drives":["D:"],"excluded_folders":["build"]}}`
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	got := LoadOptions(path)
	if len(got.ExcludedDrives) != 1 || got.ExcludedDrives[0] != "D:" || len(got.ExcludedFolders) != 1 {
		t.Fatalf("got %+v", got)
	}
	if got := LoadOptions(filepath.Join(t.TempDir(), "missing.json")); len(got.ExcludedFolders) != 0 {
		t.Fatalf("missing file: got %+v", got)
	}
}

func TestApplyExcludesUserFolders(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	dir := entryInUse | entryDir
	file := entryInUse
	s := &mftScan{entries: make([]entry, 40), links: map[uint32][]link{}}
	s.set(5, 5, dir, ".")
	s.set(16, 5, dir, "Archive") // C:\Archive, by full path
	s.set(17, 16, file, "old.zip")
	s.set(18, 5, dir, "Work")
	s.set(19, 18, dir, "Archive") // same name elsewhere: kept
	s.set(20, 19, file, "survivor.zip")
	s.set(21, 18, dir, "BUILD") // by name, any case
	s.set(22, 21, file, "out.o")
	s.set(23, 18, dir, "Secret") // D:\Work\Secret: other drive
	s.set(24, 23, file, "kept-secret.txt")

	ix := New(db, DefaultExcludedDirs, DefaultExcludedPaths, nil)
	ix.Apply(Options{
		ExcludedDrives:  []string{"e:"},
		ExcludedFolders: []string{`c:\archive\`, "build", `D:\Work\Secret`, `F:\`},
	})
	if !ix.skipDrives["E:"] || !ix.skipDrives["F:"] {
		t.Fatalf("skipped drives: %v", ix.skipDrives)
	}

	b, err := db.BeginBulk()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ix.save(b, s, "C:", 0); err != nil {
		t.Fatal(err)
	}
	if err := b.Commit(); err != nil {
		t.Fatal(err)
	}

	for name, want := range map[string]int{"old": 0, "survivor": 1, "out": 0, "kept-secret": 1} {
		got, err := db.SearchNames(name, []string{name}, 5)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != want {
			t.Errorf("%s: got %d results, want %d", name, len(got), want)
		}
	}
}
