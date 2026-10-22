package database

import (
	"path/filepath"
	"testing"
	"time"
)

// A second process opening the database while an index is being written
// must not need the write lock.
func TestOpenWhileBulkRunning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.db")
	writer, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	load(t, writer, tree)

	bulk, err := writer.BeginBulk()
	if err != nil {
		t.Fatal(err)
	}
	defer bulk.Abort()
	if err := bulk.Add(File{ID: 99, ParentID: 21, Name: "new.txt"}); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	reader, err := Open(path)
	if err != nil {
		t.Fatalf("open during bulk: %v", err)
	}
	defer reader.Close()
	if d := time.Since(start); d > time.Second {
		t.Fatalf("open waited %v for the write lock", d)
	}
	// Searches still see the previous index.
	if got := names(t, reader, "resum"); len(got) != 2 {
		t.Fatalf("search during bulk: %v", got)
	}
}
