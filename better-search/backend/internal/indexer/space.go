package indexer

import (
	"errors"
	"fmt"
	"path/filepath"

	"better-search/backend/internal/database"

	"golang.org/x/sys/windows"
)

// ErrDiskFull means the index's drive hasn't the space for a full index, or
// ran out during one.
var ErrDiskFull = errors.New("not enough disk space")

// CheckSpace makes sure the drive the index at dbPath is on has the free
// space a full index needs, before it starts.
func CheckSpace(dbPath string) error {
	dir := filepath.Dir(dbPath)
	name, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return nil
	}
	var free uint64
	if err := windows.GetDiskFreeSpaceEx(name, &free, nil, nil); err != nil {
		return nil // the folder isn't made yet, say: let the index find out
	}
	need := database.SpaceNeeded(dbPath)
	if int64(free) >= need {
		return nil
	}
	return fmt.Errorf("%w: drive %s has %d MB free and indexing needs about %d MB",
		ErrDiskFull, filepath.VolumeName(dir), free>>20, need>>20)
}
