package watcher

import (
	"errors"
	"log"
	"os"
	"runtime"
	"strings"
	"time"

	"better-search/backend/internal/database"
	"better-search/backend/internal/indexer"
	"better-search/backend/internal/memory"

	"golang.org/x/sys/windows"
)

// Changes made while the watcher wasn't running (the app was closed, the PC
// was off) never reach it. So at start it checks the index against the disk,
// but only looks at folders: adding, deleting or renaming a file updates its
// folder's modified time, so a folder whose time still matches the index has
// nothing new in it and its files are never listed.

var errStopCatchUp = errors.New("catch-up stopped")

const (
	threadModeBackgroundBegin = 0x00010000
	threadModeBackgroundEnd   = 0x00020000
)

var procSetThreadPriority = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetThreadPriority")

// catchUp checks a drive once, quietly in the background.
func (w *watcher) catchUp(drive string) {
	// Low CPU and disk priority for this thread, where the folder stats happen.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if th, err := windows.GetCurrentThread(); err == nil {
		procSetThreadPriority.Call(uintptr(th), threadModeBackgroundBegin)
		defer procSetThreadPriority.Call(uintptr(th), threadModeBackgroundEnd)
	}

	db, err := database.Open(w.dbPath)
	if err != nil {
		log.Printf("WARN: Catch-up %s: %v", drive, err)
		return
	}
	defer db.Close()

	root, mtime, ok := db.Root(drive)
	if !ok {
		return
	}
	start := time.Now()
	// Asking opens a file, and this runs once per folder: ask once a second.
	var askedAt time.Time
	var running bool
	stop := func() bool {
		if time.Since(askedAt) >= time.Second {
			askedAt, running = time.Now(), indexer.IsRunning(w.dbPath)
		}
		return running
	}
	c := &catcher{db: db, ix: w.ix.Load(), stop: stop}
	err = c.dir(drive+`\`, root, mtime)
	switch {
	case errors.Is(err, errStopCatchUp):
		log.Printf("Catch-up %s: stopped, a full index is running", drive)
	case err != nil:
		log.Printf("WARN: Catch-up %s: %v", drive, err)
	default:
		log.Printf("Catch-up %s: checked %d folders, %d had changes, in %v", drive, c.folders, c.changed, time.Since(start).Round(time.Millisecond))
	}
	memory.Trim()
}

type catcher struct {
	db   *database.DB
	ix   *indexer.Indexer
	stop func() bool // true when the catch-up should give way (a full index started)

	folders, changed int
}

// dir checks one indexed folder against the disk, then the folders inside it.
func (c *catcher) dir(path string, id, indexedMtime int64) error {
	if c.stop() {
		return errStopCatchUp
	}
	c.folders++

	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return c.remove(id)
		}
		return nil // can't look at it: leave it as it is
	}
	if info.ModTime().Unix() != indexedMtime {
		c.changed++
		if err := c.reconcile(path, id, info.ModTime().Unix()); err != nil {
			return err
		}
	}

	kids, err := c.db.ChildDirs(id)
	if err != nil {
		return err
	}
	for _, k := range kids {
		if err := c.dir(joinPath(path, k.Name), k.ID, k.Mtime); err != nil {
			return err
		}
	}
	return nil
}

func (c *catcher) remove(id int64) error {
	ch, err := c.db.BeginChanges()
	if err != nil {
		return err
	}
	if err := ch.DeleteTree(id); err != nil {
		ch.Rollback()
		return err
	}
	return ch.Commit()
}

// reconcile makes the index's list of a folder's entries match the disk.
func (c *catcher) reconcile(path string, id, mtime int64) error {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil
	}
	have, err := c.db.Children(id)
	if err != nil {
		return err
	}

	ch, err := c.db.BeginChanges()
	if err != nil {
		return err
	}
	a := &applier{ch: ch, ix: c.ix, volumes: map[uint64]int64{}, db: c.db}

	onDisk := make(map[string]bool, len(entries))
	for _, e := range entries {
		onDisk[e.Name()] = true
	}
	// Removals first: a renamed entry is a removal and an addition, and the
	// removal must not take out the row the addition just wrote.
	for name, child := range have {
		if !onDisk[name] {
			if err := ch.DeleteTree(child.ID); err != nil {
				ch.Rollback()
				return err
			}
		}
	}
	for _, e := range entries {
		if known, ok := have[e.Name()]; ok && unchanged(known, e) {
			continue
		}
		if err := a.path(joinPath(path, e.Name())); err != nil {
			ch.Rollback()
			return err
		}
	}
	if err := ch.SetMtime(id, mtime); err != nil {
		ch.Rollback()
		return err
	}
	return ch.Commit()
}

// unchanged is true if an entry is as the index has it. Files are compared by
// size and time; folders are checked on their own turn.
func unchanged(known database.Child, e os.DirEntry) bool {
	if known.IsDir != e.IsDir() {
		return false
	}
	if e.IsDir() {
		return true
	}
	info, err := e.Info()
	return err == nil && known.Size == info.Size() && known.Mtime == info.ModTime().Unix()
}

func joinPath(dir, name string) string {
	if strings.HasSuffix(dir, `\`) {
		return dir + name
	}
	return dir + `\` + name
}
