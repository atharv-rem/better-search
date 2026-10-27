// Package watcher keeps the index up to date between full indexes. Windows
// tells it which files were created, changed, renamed or deleted
// (ReadDirectoryChangesW), so nothing polls: it sleeps until a change comes
// in, applies a batch of them, and sleeps again.
//
// Events only mark paths as "dirty". Each dirty path is then looked at on
// disk: if it exists it's added or updated, if not it's removed. That way a
// rename, a delete and a re-create in quick succession all come out right
// whatever order the events arrived in.
package watcher

import (
	"encoding/binary"
	"errors"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"
	"unsafe"

	"better-search/backend/internal/database"
	"better-search/backend/internal/indexer"
	"better-search/backend/internal/memory"

	"golang.org/x/sys/windows"
)

const (
	bufferSize = 256 << 10 // bytes Windows can queue between reads, per drive
	settleTime = 2 * time.Second
	retryTime  = 15 * time.Second
	idleTime   = 30 * time.Second // after the last batch, before closing the index and trimming memory
	maxDirty   = 200_000 // more than this and we give up tracking paths and mark the index stale

	notifyMask = windows.FILE_NOTIFY_CHANGE_FILE_NAME |
		windows.FILE_NOTIFY_CHANGE_DIR_NAME |
		windows.FILE_NOTIFY_CHANGE_SIZE |
		windows.FILE_NOTIFY_CHANGE_LAST_WRITE

	refMask = 0x0000FFFFFFFFFFFF // low 48 bits of a file reference = MFT record number
)

type watcher struct {
	dbPath       string
	settingsPath string
	ownDir       string // the app's own data folder; its writes must not be watched

	ix         atomic.Pointer[indexer.Indexer]
	settingsAt time.Time

	mu       sync.Mutex
	dirty    map[string]struct{}
	overflow bool // events were lost, or too many to keep track of
	pending  bool // a flush is scheduled

	// Held while a batch is applied, and for db and idle.
	procMu sync.Mutex
	// The index, kept open from one batch to the next while changes keep
	// coming (a build, a download), and closed once they stop (goIdle).
	db   *database.DB
	idle *time.Timer
}

// Run watches every indexed NTFS drive until the process is stopped. Returns
// the exit code.
func Run(dbPath, settingsPath string) int {
	// Idle most of the time: keep the heap small and give memory back.
	debug.SetGCPercent(25)
	debug.SetMemoryLimit(48 << 20)

	lockName, _ := windows.UTF16PtrFromString(filepath.Join(filepath.Dir(dbPath), "watch.lock"))
	lock, err := windows.CreateFile(lockName, windows.GENERIC_WRITE, 0, nil, windows.CREATE_ALWAYS,
		windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_DELETE_ON_CLOSE, 0)
	if err != nil {
		log.Printf("Another watcher is already running: %v", err)
		return 0
	}
	defer windows.CloseHandle(lock)

	w := &watcher{
		dbPath:       dbPath,
		settingsPath: settingsPath,
		ownDir:       strings.ToLower(filepath.Dir(dbPath)),
		dirty:        map[string]struct{}{},
	}
	w.refreshRules()

	drives, err := indexer.FixedDrives()
	if err != nil {
		log.Printf("ERROR: List drives: %v", err)
		return 1
	}
	var wg sync.WaitGroup
	for _, d := range drives {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.watchDrive(d)
		}()
	}
	wg.Wait()
	return 0
}

// refreshRules rebuilds the exclusion rules if settings.json changed.
func (w *watcher) refreshRules() {
	var at time.Time
	if info, err := os.Stat(w.settingsPath); err == nil {
		at = info.ModTime()
	}
	if w.ix.Load() != nil && at.Equal(w.settingsAt) {
		return
	}
	w.settingsAt = at
	ix := indexer.New(nil, indexer.DefaultExcludedDirs, indexer.DefaultExcludedPaths, nil)
	ix.Apply(indexer.LoadOptions(w.settingsPath))
	w.ix.Store(ix)
}

// watchDrive waits for the drive's volume to be known to the index, then
// reads its change notifications forever.
func (w *watcher) watchDrive(drive string) {
	root := drive + `\`
	first := true
	for {
		volume, ok := w.volumeIndex(root)
		if !ok {
			time.Sleep(5 * time.Minute) // not indexed yet, or not NTFS
			continue
		}
		if first {
			// Once per run: look for what changed while we weren't running.
			// Changes from here on come in as events.
			first = false
			go w.catchUp(drive)
		}
		w.readChanges(drive, volume)
		time.Sleep(retryTime)
	}
}

func (w *watcher) volumeIndex(root string) (int64, bool) {
	serial, _, err := fileID(root)
	if err != nil {
		return 0, false
	}
	db, err := database.Open(w.dbPath)
	if err != nil {
		return 0, false
	}
	defer db.Close()
	v, ok, _ := db.LookupVolume(serial)
	return v, ok
}

func (w *watcher) readChanges(drive string, volume int64) {
	root, _ := windows.UTF16PtrFromString(drive + `\`)
	h, err := windows.CreateFile(root, windows.FILE_LIST_DIRECTORY,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		log.Printf("ERROR: Watch %s: %v", drive, err)
		return
	}
	defer windows.CloseHandle(h)
	log.Printf("Watching %s", drive)

	buf := make([]byte, bufferSize)
	for {
		var n uint32
		err := windows.ReadDirectoryChanges(h, &buf[0], uint32(len(buf)), true, notifyMask, &n, nil, 0)
		if errors.Is(err, windows.ERROR_NOTIFY_ENUM_DIR) || (err == nil && n == 0) {
			log.Printf("WARN: Watch %s: too many changes at once, some were missed", drive)
			w.markOverflow()
			continue
		}
		if err != nil {
			log.Printf("ERROR: Watch %s: %v", drive, err)
			return
		}
		w.refreshRules()

		for off := uint32(0); ; {
			rec := buf[off:n]
			if len(rec) < 12 {
				break
			}
			next := binary.LittleEndian.Uint32(rec[0:])
			nameLen := binary.LittleEndian.Uint32(rec[8:]) / 2
			if 12+nameLen*2 <= uint32(len(rec)) {
				u := unsafe.Slice((*uint16)(unsafe.Pointer(&rec[12])), nameLen)
				w.add(drive + `\` + string(utf16.Decode(u)))
			}
			if next == 0 {
				break
			}
			off += next
		}
	}
}

// add marks a path dirty, unless it's somewhere the index never looks.
func (w *watcher) add(path string) {
	if strings.HasPrefix(strings.ToLower(path), w.ownDir) {
		return
	}
	// Only the folders above it: whether the path itself is left out depends
	// on whether it's a folder, which is checked once it's looked at.
	if w.ix.Load().Excluded(filepath.Dir(path), true) {
		return
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.dirty) >= maxDirty {
		w.overflow = true
		return
	}
	w.dirty[path] = struct{}{}
	w.schedule(settleTime)
}

func (w *watcher) markOverflow() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.overflow = true
	w.schedule(settleTime)
}

// schedule must be called with mu held.
func (w *watcher) schedule(after time.Duration) {
	if w.pending {
		return
	}
	w.pending = true
	time.AfterFunc(after, w.flush)
}

func (w *watcher) flush() {
	w.procMu.Lock()
	defer w.procMu.Unlock()

	w.mu.Lock()
	paths := w.dirty
	overflow := w.overflow
	w.dirty = map[string]struct{}{}
	w.overflow = false
	w.pending = false
	w.mu.Unlock()

	retry := func() {
		w.mu.Lock()
		defer w.mu.Unlock()
		for p := range paths {
			w.dirty[p] = struct{}{}
		}
		w.overflow = w.overflow || overflow
		w.schedule(retryTime)
	}

	// A full index replaces the files table and makes our changes pointless
	// (or impossible: it holds the write lock). Keep them for after.
	if indexer.IsRunning(w.dbPath) {
		retry()
		return
	}
	err := w.apply(paths, overflow)
	if err != nil {
		log.Printf("WARN: Apply changes: %v", err)
		w.closeDB() // opened again for the retry, in case it was the connection
		retry()
	}
	// Not after every batch: while changes keep coming, a trim would only
	// throw away what the next batch, 2 s later, reads back in.
	if w.idle == nil {
		w.idle = time.AfterFunc(idleTime, w.goIdle)
	} else {
		w.idle.Reset(idleTime)
	}
}

// goIdle runs once no batch has come for idleTime: it closes the index, and
// its page cache, and gives the memory back.
func (w *watcher) goIdle() {
	w.procMu.Lock()
	defer w.procMu.Unlock()
	w.closeDB()
	memory.Trim()
}

// closeDB must be called with procMu held.
func (w *watcher) closeDB() {
	if w.db != nil {
		w.db.Close()
		w.db = nil
	}
}

// apply brings the index in line with the disk for every dirty path. Called
// with procMu held.
func (w *watcher) apply(paths map[string]struct{}, overflow bool) error {
	if len(paths) == 0 && !overflow {
		return nil
	}
	if w.db == nil {
		db, err := database.Open(w.dbPath)
		if err != nil {
			return err
		}
		w.db = db
	}
	db := w.db

	if overflow {
		if err := db.MarkStale(); err != nil {
			return err
		}
	}
	if len(paths) == 0 {
		return nil
	}

	// Folders before what's inside them.
	sorted := make([]string, 0, len(paths))
	for p := range paths {
		sorted = append(sorted, p)
	}
	sort.Slice(sorted, func(i, j int) bool {
		di, dj := strings.Count(sorted[i], `\`), strings.Count(sorted[j], `\`)
		if di != dj {
			return di < dj
		}
		return sorted[i] < sorted[j]
	})

	ch, err := db.BeginChanges()
	if err != nil {
		return err
	}
	a := &applier{ch: ch, ix: w.ix.Load(), volumes: map[uint64]int64{}, db: db}
	for _, p := range sorted {
		if err := a.path(p); err != nil {
			ch.Rollback()
			return err
		}
	}
	return ch.Commit()
}
