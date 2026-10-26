package database

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestIsDiskFull(t *testing.T) {
	full := &os.PathError{Op: "write", Path: "index.db", Err: syscall.Errno(112)}
	if !IsDiskFull(fmt.Errorf("finish bulk index: %w", full)) {
		t.Error("ERROR_DISK_FULL not seen as a full disk")
	}
	if IsDiskFull(errors.New("database or disk is full")) || IsDiskFull(syscall.Errno(5)) {
		t.Error("other errors seen as a full disk")
	}
}

func TestSpaceNeeded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.db")
	if got := SpaceNeeded(path); got != MinFreeSpace {
		t.Errorf("no index: got %d, want %d", got, MinFreeSpace)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	f.Truncate(200 << 20)
	f.Close()
	if got := SpaceNeeded(path); got != 600<<20 {
		t.Errorf("200 MB index: got %d, want %d", got, 600<<20)
	}
}
