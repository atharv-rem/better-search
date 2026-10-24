package watcher

import (
	"io/fs"
	"os"
	"path/filepath"
	"unsafe"

	"better-search/backend/internal/database"
	"better-search/backend/internal/indexer"

	"golang.org/x/sys/windows"
)

// applier writes one batch of changes.
type applier struct {
	ch      *database.Changes
	db      *database.DB
	ix      *indexer.Indexer
	volumes map[uint64]int64 // NTFS serial -> index volume number
}

// path makes the index match what's on disk at one path.
func (a *applier) path(p string) error {
	info, err := os.Lstat(p)
	if err != nil {
		if os.IsNotExist(err) {
			return a.remove(p)
		}
		return nil // can't look at it (access denied...): leave the index alone
	}
	if a.ix.Excluded(p, info.IsDir()) {
		return a.remove(p) // e.g. a folder renamed into an excluded name
	}

	id, parent, ok := a.ids(p)
	if !ok {
		return nil
	}
	if has, err := a.ch.Has(parent); err != nil || !has {
		return err // its folder isn't in the index, so neither is it
	}
	existed, err := a.upsert(id, parent, filepath.Base(p), info)
	if err != nil {
		return err
	}
	if info.IsDir() && !existed {
		return a.walk(p, id) // a new folder (or one moved in) brings its contents
	}
	return nil
}

func (a *applier) remove(p string) error {
	id, found, err := a.ch.FindByPath(p)
	if err != nil || !found {
		return err
	}
	return a.ch.DeleteTree(id)
}

func (a *applier) upsert(id, parent int64, name string, info fs.FileInfo) (bool, error) {
	f := database.File{
		ID:         id,
		ParentID:   parent,
		Name:       name,
		IsDir:      info.IsDir(),
		Size:       info.Size(),
		ModifiedAt: info.ModTime().Unix(),
	}
	if f.IsDir {
		f.Size = 0
	}
	return a.ch.Upsert(f)
}

// walk adds everything inside a new folder.
func (a *applier) walk(dir string, dirID int64) error {
	ids := map[string]int64{dir: dirID}
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if p == dir {
			return nil
		}
		if a.ix.Excluded(p, d.IsDir()) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		id, _, ok := a.ids(p)
		if !ok {
			return nil
		}
		parent, ok := ids[filepath.Dir(p)]
		if !ok {
			return nil
		}
		if _, err := a.upsert(id, parent, d.Name(), info); err != nil {
			return err
		}
		if d.IsDir() {
			ids[p] = id
		}
		return nil
	})
}

// ids returns the row ids of a path and of its folder: the volume number in
// the high bits and the MFT record number in the low ones, as the index
// stores them.
func (a *applier) ids(p string) (id, parent int64, ok bool) {
	serial, record, err := fileID(p)
	if err != nil {
		return 0, 0, false
	}
	pSerial, pRecord, err := fileID(filepath.Dir(p))
	if err != nil || pSerial != serial {
		return 0, 0, false
	}
	vol, known := a.volumes[serial]
	if !known {
		v, found, _ := a.db.LookupVolume(serial)
		if !found {
			return 0, 0, false
		}
		vol, a.volumes[serial] = v, v
	}
	return vol<<32 | int64(record), vol<<32 | int64(pRecord), true
}

// fileIDInfo is FILE_ID_INFO.
type fileIDInfo struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

// fileID reads a file's volume serial number and MFT record number. It needs
// no administrator rights and doesn't follow links.
func fileID(path string) (serial uint64, record uint32, err error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	h, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, 0, err
	}
	defer windows.CloseHandle(h)

	var info fileIDInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileIdInfo,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return 0, 0, err
	}
	ref := uint64(info.FileID[0]) | uint64(info.FileID[1])<<8 | uint64(info.FileID[2])<<16 |
		uint64(info.FileID[3])<<24 | uint64(info.FileID[4])<<32 | uint64(info.FileID[5])<<40 |
		uint64(info.FileID[6])<<48 | uint64(info.FileID[7])<<56
	return info.VolumeSerialNumber, uint32(ref & refMask), nil
}
