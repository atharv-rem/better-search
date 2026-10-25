package indexer

import (
	"encoding/gob"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"better-search/backend/internal/database"

	"golang.org/x/sys/windows"
)

// pipeSession is a Session whose "indexer" is this test process, which
// connects with indexer, as the elevated program would after reading drives.
func pipeSession(t *testing.T, indexer func(c *helperConn, opts Options) error) (*Session, chan error) {
	t.Helper()
	pipe, name, err := createPipe()
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		h, err := openPipe(name)
		if err != nil {
			done <- err
			return
		}
		f := os.NewFile(uintptr(h), name)
		defer f.Close()
		c := &helperConn{enc: gob.NewEncoder(f), dec: json.NewDecoder(f)}
		var hello toIndexer
		if err := c.dec.Decode(&hello); err != nil || hello.Options == nil {
			done <- fmt.Errorf("no options: %v", err)
			return
		}
		done <- indexer(c, *hello.Options)
	}()
	return &Session{pipe: pipe, proc: windows.CurrentProcess(), name: name}, done
}

func TestPipeIndex(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	const files = 10_000 // a few messages' worth
	s, done := pipeSession(t, func(c *helperConn, opts Options) error {
		if len(opts.ExcludedDrives) != 1 || opts.ExcludedDrives[0] != "D:" {
			return fmt.Errorf("options: %+v", opts)
		}
		c.send(fromIndexer{Log: "reading C:"})
		index, err := c.VolumeIndex(0xC0FFEE)
		if err != nil {
			return err
		}
		bulk, err := c.BeginBulk()
		if err != nil {
			return err
		}
		root := index<<32 | rootRecord
		if err := bulk.Add(database.File{ID: root, Name: "C:", IsDir: true}); err != nil {
			return err
		}
		for i := range files {
			f := database.File{ID: root + 1 + int64(i), ParentID: root, Name: fmt.Sprintf("file%d.txt", i)}
			if err := bulk.Add(f); err != nil {
				return err
			}
		}
		c.send(fromIndexer{Progress: &Progress{Drive: "C:", Phase: "saving", Done: 1, Total: 1}})
		if err := bulk.Commit(); err != nil {
			return err
		}
		return c.send(fromIndexer{Done: true, Stats: []DriveStats{{Drive: "C:", Files: files + 1}}})
	})

	var progress int
	stats, err := s.Serve(db, Options{ExcludedDrives: []string{"D:"}}, func(Progress) { progress++ })
	if err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(stats) != 1 || stats[0].Files != files+1 || progress != 1 {
		t.Fatalf("stats %+v, %d progress reports", stats, progress)
	}
	if n, _ := db.FileCount(); n != files+1 {
		t.Fatalf("saved %d files, want %d", n, files+1)
	}
}

func TestPipeIndexFails(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	s, done := pipeSession(t, func(c *helperConn, _ Options) error {
		bulk, err := c.BeginBulk()
		if err != nil {
			return err
		}
		bulk.Add(database.File{ID: rootRecord, Name: "C:", IsDir: true})
		c.flush()
		return c.send(fromIndexer{Error: "drive went away"})
	})
	if _, err := s.Serve(db, Options{}, func(Progress) {}); err == nil || err.Error() != "drive went away" {
		t.Fatalf("got %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if n, _ := db.FileCount(); n != 0 {
		t.Fatalf("a failed index saved %d files", n)
	}
}

// Only an indexing pipe: the elevated indexer mustn't open whatever path
// it's handed.
func TestOpenPipeRefusesOtherPaths(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x")
	os.WriteFile(path, nil, 0o644)
	for _, name := range []string{path, `\\.\pipe\other`, pipePrefix + `..\..\C:\x`} {
		if h, err := openPipe(name); err == nil {
			windows.CloseHandle(h)
			t.Errorf("opened %s", name)
		}
	}
}
