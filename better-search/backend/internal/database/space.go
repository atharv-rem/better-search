package database

import (
	"errors"
	"os"
	"syscall"

	"modernc.org/sqlite"
)

// MinFreeSpace is the least free space a full index asks for, enough for
// about 400,000 files (an index takes ~230 bytes a file).
const MinFreeSpace = 300 << 20

// SpaceNeeded is how much free space a full index wants on the drive of the
// index at path. At its peak it holds the old index, the new one in the WAL
// and the search tables being rebuilt, so three times the current index.
// The app's shell works this out the same way (storage.rs).
func SpaceNeeded(path string) int64 {
	var size int64
	for _, f := range []string{path, path + "-wal"} {
		if info, err := os.Stat(f); err == nil {
			size += info.Size()
		}
	}
	return max(MinFreeSpace, 3*size)
}

// IsDiskFull reports whether err is SQLite or Windows running out of space.
func IsDiskFull(err error) bool {
	var sqlErr *sqlite.Error
	if errors.As(err, &sqlErr) && sqlErr.Code()&0xff == 13 { // SQLITE_FULL
		return true
	}
	var errno syscall.Errno
	// ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL
	return errors.As(err, &errno) && (errno == 39 || errno == 112)
}
