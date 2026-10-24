package watcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"better-search/backend/internal/database"
	"better-search/backend/internal/indexer"
)

// seed puts the folders from the drive root down to dir in the index, the way
// a full index would have, and returns an applier for batches of changes.
func seed(t *testing.T, db *database.DB, dir string) *applier {
	t.Helper()
	serial, _, err := fileID(filepath.VolumeName(dir) + `\`)
	if err != nil {
		t.Skipf("not an NTFS volume: %v", err)
	}
	vol, err := db.VolumeIndex(serial)
	if err != nil {
		t.Fatal(err)
	}

	ch, err := db.BeginChanges()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(dir, `\`)
	for i := range parts {
		p := strings.Join(parts[:i+1], `\`)
		if i == 0 {
			p += `\`
		}
		_, rec, err := fileID(p)
		if err != nil {
			t.Fatal(err)
		}
		f := database.File{ID: vol<<32 | int64(rec), Name: parts[i], IsDir: true}
		if i > 0 {
			_, prec, _ := fileID(strings.Join(parts[:i], `\`) + `\`)
			f.ParentID = vol<<32 | int64(prec)
		}
		if _, err := ch.Upsert(f); err != nil {
			t.Fatal(err)
		}
	}
	if err := ch.Commit(); err != nil {
		t.Fatal(err)
	}
	return nil
}

func apply(t *testing.T, db *database.DB, ix *indexer.Indexer, paths ...string) {
	t.Helper()
	ch, err := db.BeginChanges()
	if err != nil {
		t.Fatal(err)
	}
	a := &applier{ch: ch, ix: ix, volumes: map[uint64]int64{}, db: db}
	for _, p := range paths {
		if err := a.path(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := ch.Commit(); err != nil {
		t.Fatal(err)
	}
}

func has(t *testing.T, db *database.DB, path string) bool {
	t.Helper()
	ch, err := db.BeginChanges()
	if err != nil {
		t.Fatal(err)
	}
	defer ch.Rollback()
	_, ok, err := ch.FindByPath(path)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func TestAddRenameDelete(t *testing.T) {
	dir, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	seed(t, db, dir)
	ix := indexer.New(db, nil, nil, nil)

	// A new file shows up.
	file := filepath.Join(dir, "report.txt")
	os.WriteFile(file, []byte("hello"), 0o644)
	apply(t, db, ix, file)
	if !has(t, db, file) {
		t.Fatal("new file not added")
	}

	// A new folder brings what's inside it.
	sub := filepath.Join(dir, "docs")
	os.MkdirAll(filepath.Join(sub, "deep"), 0o755)
	os.WriteFile(filepath.Join(sub, "deep", "a.txt"), nil, 0o644)
	apply(t, db, ix, sub)
	if !has(t, db, filepath.Join(sub, "deep", "a.txt")) {
		t.Fatal("contents of new folder not added")
	}

	// Renaming a folder moves everything in it, in either event order.
	moved := filepath.Join(dir, "papers")
	os.Rename(sub, moved)
	apply(t, db, ix, sub, moved)
	if has(t, db, sub) || !has(t, db, filepath.Join(moved, "deep", "a.txt")) {
		t.Fatal("renamed folder not followed")
	}
	moved2 := filepath.Join(dir, "essays")
	os.Rename(moved, moved2)
	apply(t, db, ix, moved2, moved)
	if has(t, db, moved) || !has(t, db, filepath.Join(moved2, "deep", "a.txt")) {
		t.Fatal("renamed folder not followed (new name first)")
	}

	// A file replaced by saving a copy over it is one row, not two.
	tmp := filepath.Join(dir, "report.tmp")
	os.WriteFile(tmp, []byte("new contents"), 0o644)
	os.Rename(tmp, file)
	apply(t, db, ix, tmp, file)
	if !has(t, db, file) || has(t, db, tmp) {
		t.Fatal("replaced file wrong")
	}

	// Deletes.
	os.Remove(file)
	os.RemoveAll(moved2)
	apply(t, db, ix, file, moved2)
	if has(t, db, file) || has(t, db, moved2) || has(t, db, filepath.Join(moved2, "deep", "a.txt")) {
		t.Fatal("deleted files still in the index")
	}
}

func TestExcludedFoldersAreSkipped(t *testing.T) {
	dir, _ := filepath.Abs(t.TempDir())
	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	seed(t, db, dir)
	ix := indexer.New(db, indexer.DefaultExcludedDirs, nil, nil)

	nm := filepath.Join(dir, "app", "node_modules", "pkg")
	os.MkdirAll(nm, 0o755)
	os.WriteFile(filepath.Join(nm, "index.js"), nil, 0o644)
	app := filepath.Join(dir, "app")
	os.WriteFile(filepath.Join(app, "main.js"), nil, 0o644)
	apply(t, db, ix, app, filepath.Join(app, "node_modules"), filepath.Join(nm, "index.js"))

	if !has(t, db, filepath.Join(app, "main.js")) {
		t.Fatal("normal file missing")
	}
	if has(t, db, filepath.Join(app, "node_modules")) || has(t, db, filepath.Join(nm, "index.js")) {
		t.Fatal("excluded folder was indexed")
	}
}

func TestCatchUpFindsChangesMadeWhileOff(t *testing.T) {
	dir, _ := filepath.Abs(t.TempDir())
	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	seed(t, db, dir)
	ix := indexer.New(db, indexer.DefaultExcludedDirs, nil, nil)

	// The index as it was when the app last ran.
	keep := filepath.Join(dir, "keep.txt")
	gone := filepath.Join(dir, "gone.txt")
	old := filepath.Join(dir, "old-name")
	os.WriteFile(keep, []byte("k"), 0o644)
	os.WriteFile(gone, []byte("g"), 0o644)
	os.MkdirAll(filepath.Join(old, "inner"), 0o755)
	os.WriteFile(filepath.Join(old, "inner", "deep.txt"), nil, 0o644)
	apply(t, db, ix, dir, keep, gone, old)

	// Changes made while it wasn't running. Times are kept in whole seconds,
	// so wait one out, as any real gap would.
	time.Sleep(1100 * time.Millisecond)
	added := filepath.Join(dir, "added.txt")
	os.WriteFile(added, []byte("a"), 0o644)
	os.Remove(gone)
	renamed := filepath.Join(dir, "new-name")
	os.Rename(old, renamed)
	nested := filepath.Join(dir, "fresh", "a", "b")
	os.MkdirAll(nested, 0o755)
	os.WriteFile(filepath.Join(nested, "c.txt"), nil, 0o644)
	nm := filepath.Join(dir, "node_modules", "x")
	os.MkdirAll(nm, 0o755)

	_, rec, _ := fileID(dir)
	serial, _, _ := fileID(dir)
	vol, _, _ := db.LookupVolume(serial)
	id := vol<<32 | int64(rec)
	mtime, _ := db.Dir(id)

	c := &catcher{db: db, ix: ix, stop: func() bool { return false }}
	if err := c.dir(dir, id, mtime); err != nil {
		t.Fatal(err)
	}

	for _, p := range []string{keep, added, filepath.Join(renamed, "inner", "deep.txt"), filepath.Join(nested, "c.txt")} {
		if !has(t, db, p) {
			t.Errorf("%s missing from the index", p)
		}
	}
	for _, p := range []string{gone, old, filepath.Join(old, "inner", "deep.txt"), filepath.Join(dir, "node_modules")} {
		if has(t, db, p) {
			t.Errorf("%s should not be in the index", p)
		}
	}

	// Nothing changed since: no folder needs a look inside.
	c = &catcher{db: db, ix: ix, stop: func() bool { return false }}
	mtime, _ = db.Dir(id)
	if err := c.dir(dir, id, mtime); err != nil {
		t.Fatal(err)
	}
	if c.changed != 0 {
		t.Errorf("second pass looked inside %d folders, want 0", c.changed)
	}
}
