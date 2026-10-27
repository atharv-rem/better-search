package indexer

import (
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"better-search/backend/internal/database"

	"golang.org/x/sys/windows"
)

var ErrNotElevated = errors.New("reading the MFT needs administrator rights")

// DefaultExcludedDirs are folder names skipped (with everything inside them)
// on every drive. Matching ignores case.
var DefaultExcludedDirs = []string{
	"$Recycle.Bin",
	"System Volume Information",
	"$WinREAgent",
	"Config.Msi",
	"WinSxS",
	"node_modules",
	".git",

	// Browser and Electron caches: hash-named blobs nobody searches for.
	"Cache",
	"Code Cache",
	"Cache_Data",
	"cache2",
	"GPUCache",
	"DawnCache",
	"DawnWebGPUCache",
	"DawnGraphiteCache",
	"GrShaderCache",
	"ShaderCache",
	"Service Worker",
	"IndexedDB",
	"Crashpad",
	"blob_storage",
	"Shared Dictionary",
	"User Data",
	"EBWebView",
	"WebStorage",
	"Local Storage",
	"Session Storage",
	"workspaceStorage",
	"CachedData",
	"CachedExtensionVSIXs",
	"jcef_cache",

	// Tool caches and scratch space.
	".cache",
	"caches",
	".tmp",
	"npm-cache",
	"pnpm-cache",
	"go-build",
	"gopls",

	// Build output and virtualenvs. Rust's "target" is handled separately.
	".next",
	".nuxt",
	".svelte-kit",
	".angular",
	".turbo",
	".parcel-cache",
	".gradle",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".venv",
	"venv",
	"testdata",
}

// DefaultExcludedPaths are folders skipped by their position from the drive
// root, for names too common to skip everywhere. "*" matches any one folder.
// Matching ignores case.
var DefaultExcludedPaths = []string{
	// Package stores and toolchains.
	`Users\*\AppData\Local\pnpm\store`,
	`Users\*\AppData\Local\pip\cache`,
	`Users\*\go\pkg\mod`,
	`Users\*\.cargo\registry`,
	`Users\*\.rustup\toolchains`,
	`Users\*\.vscode\extensions`,
	`Users\*\.cursor\extensions`,
	`Users\*\.windsurf\extensions`,
	`Users\*\.antigravity\extensions`,

	// Bundled toolchains, IDE plugins and IDE indexes.
	`Program Files\JetBrains\*\plugins`,
	`Program Files\JetBrains\*\bin\cmake`,
	`Program Files\JetBrains\*\bin\mingw`,
	`Users\*\AppData\Roaming\JetBrains\*\plugins`,
	`Users\*\AppData\Local\JetBrains\*\index`,
	`Program Files\PostgreSQL\*\pgAdmin 4\python`,
	`Program Files\Go\test`,

	// App internals.
	`Program Files\WindowsApps`,
	`Users\*\AppData\Local\Packages`,
	`Users\*\AppData\Local\Temp`,
	`Users\*\AppData\Local\SquirrelTemp`,
	`Users\*\AppData\Roaming\Microsoft\Windows\Recent`, // shortcuts to recently opened files, not the files
	`Users\*\AppData\Roaming\zen\Profiles\*\storage`,
	`Users\*\AppData\Roaming\Mozilla\Firefox\Profiles\*\storage`,
	`Users\*\AppData\Roaming\*\User\History`, // VS Code-style editors' local history
	`ProgramData\Lenovo\UserGuide`,
	`ProgramData\Lenovo\Vantage\Addins`,

	// Windows internals.
	`Windows\Temp`,
	`Windows\servicing`,
	`Windows\Installer`,
	`Windows\assembly`,
	`Windows\Prefetch`,
	`Windows\SoftwareDistribution`,
	`ProgramData\Package Cache`,
	`Windows\System32\config\systemprofile`,
	`Windows\SysWOW64\config\systemprofile`,
	`Windows\System32\CatRoot`,
	`Windows\System32\catroot2`,
	`Windows\System32\DriverStore`,
	`ProgramData\Microsoft\NetFramework\BreadcrumbStore`,
	`ProgramData\Microsoft\Windows\DeviceMetadataCache`,
	`ProgramData\Microsoft\Windows\WER`,
	`ProgramData\Microsoft\Windows\AppRepository`,
	`ProgramData\Microsoft\Search\Data`,
}

// pathRule is one folder level of the compiled DefaultExcludedPaths.
type pathRule struct {
	next     map[string]*pathRule // lower-cased name, or "*"
	excluded bool                 // a rule ends here
}

func compilePaths(paths []string) *pathRule {
	root := &pathRule{next: map[string]*pathRule{}}
	for _, p := range paths {
		n := root
		for _, part := range strings.Split(strings.Trim(p, `\`), `\`) {
			part = strings.ToLower(part)
			c := n.next[part]
			if c == nil {
				c = &pathRule{next: map[string]*pathRule{}}
				n.next[part] = c
			}
			n = c
		}
		n.excluded = true
	}
	return root
}

// step returns the rules that are live inside a folder called name, given the
// rules live in its parent, and whether a rule excludes that folder.
func step(live []*pathRule, name string) ([]*pathRule, bool) {
	var out []*pathRule
	for _, n := range live {
		for _, c := range [2]*pathRule{n.next[name], n.next["*"]} {
			if c == nil {
				continue
			}
			if c.excluded {
				return nil, true
			}
			out = append(out, c)
		}
	}
	return out, false
}

type Progress struct {
	Drive string `json:"drive"`
	Phase string `json:"phase"` // "reading" the MFT, or "saving" rows
	Done  int64  `json:"done"`
	Total int64  `json:"total"`
}

type DriveStats struct {
	Drive      string `json:"drive"`
	Records    int64  `json:"records"`
	Files      int64  `json:"files"`
	DurationMs int64  `json:"duration_ms"`
}

// Store is where Run writes the index. The elevated indexer has no database
// of its own: its Store sends everything to the search helper (elevated.go).
type Store interface {
	VolumeIndex(serial uint64) (int64, error)
	BeginBulk() (Bulk, error)
}

// Bulk replaces the whole files table, like database.Bulk.
type Bulk interface {
	Add(f database.File) error
	Commit() error
	Abort()
}

type Indexer struct {
	store      Store
	excluded   map[string]bool
	paths      *pathRule
	onProgress func(Progress)

	// From the user's settings (see Apply).
	skipDrives map[string]bool
	drivePaths map[string]*pathRule // by drive, "" for every drive

	// Folders checked for a Cargo.toml (see hasCargoToml), by lower-cased
	// path. The watcher calls Excluded from a goroutine per drive.
	cargoMu sync.Mutex
	cargo   map[string]cargoSeen
}

// New makes an indexer that writes to store, which only Run needs.
func New(store Store, excludedDirs, excludedPaths []string, onProgress func(Progress)) *Indexer {
	ex := make(map[string]bool, len(excludedDirs))
	for _, d := range excludedDirs {
		ex[strings.ToLower(d)] = true
	}
	if onProgress == nil {
		onProgress = func(Progress) {}
	}
	return &Indexer{store: store, excluded: ex, paths: compilePaths(excludedPaths), onProgress: onProgress}
}

// Run indexes every fixed NTFS drive and replaces the whole files table.
// Non-NTFS drives are skipped.
func (ix *Indexer) Run() ([]DriveStats, error) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return nil, ErrNotElevated
	}

	drives, err := fixedDrives()
	if err != nil {
		return nil, err
	}

	// Open volumes and assign their id ranges before the bulk transaction
	// takes the write lock.
	type target struct {
		vol   *volume
		index int64
	}
	var targets []target
	defer func() {
		for _, t := range targets {
			t.vol.Close()
		}
	}()
	for _, d := range drives {
		if ix.skipDrives[d] {
			log.Printf("Skipping %s: excluded in settings", d)
			continue
		}
		v, err := openVolume(d)
		if err != nil {
			log.Printf("WARN: Skipping %s: %v", d, err)
			continue
		}
		idx, err := ix.store.VolumeIndex(v.serial)
		if err != nil {
			v.Close()
			return nil, err
		}
		targets = append(targets, target{v, idx})
	}
	if len(targets) == 0 {
		return nil, errors.New("no NTFS drives to index")
	}

	bulk, err := ix.store.BeginBulk()
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			bulk.Abort()
		}
	}()

	var stats []DriveStats
	for _, t := range targets {
		start := time.Now()
		scan, err := t.vol.scan(func(done, total int64) {
			ix.onProgress(Progress{Drive: t.vol.drive, Phase: "reading", Done: done, Total: total})
		})
		if err != nil {
			return nil, err
		}
		n, err := ix.save(bulk, scan, t.vol.drive, t.index)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", t.vol.drive, err)
		}
		took := time.Since(start)
		s := DriveStats{Drive: t.vol.drive, Records: int64(len(scan.entries)), Files: n, DurationMs: took.Milliseconds()}
		log.Printf("Indexed %s: %d files from %d MFT records in %v", s.Drive, s.Files, s.Records, took.Round(time.Millisecond))
		stats = append(stats, s)
	}

	commitStart := time.Now()
	if err := bulk.Commit(); err != nil {
		return nil, err
	}
	committed = true
	log.Printf("Search index built in %v", time.Since(commitStart).Round(time.Millisecond))
	return stats, nil
}

const (
	stateUnknown uint8 = iota
	stateIncluded
	stateExcluded
	stateVisiting
)

// save works out which records belong in the index (reachable from the root
// folder and not inside an excluded folder) and writes them out.
func (ix *Indexer) save(bulk Bulk, s *mftScan, drive string, volIndex int64) (int64, error) {
	entries := s.entries
	state := make([]uint8, len(entries))
	base := volIndex << 32

	isDir := func(r uint32) bool {
		return int(r) < len(entries) && entries[r].flags&entryDir != 0
	}

	// Folders holding a Cargo.toml, whose "target" folder is build output.
	cargo := map[uint32]bool{}
	for i := range entries {
		e := &entries[i]
		if e.flags&entryDir == 0 && strings.EqualFold(s.name(e.name, e.nameLen), "Cargo.toml") {
			cargo[e.parent] = true
		}
	}

	// Path rules still live inside each included folder; only folders on the
	// way down a DefaultExcludedPaths entry have any.
	live := map[uint32][]*pathRule{rootRecord: ix.rootRules(drive)}

	var resolve func(r uint32) bool
	// accept is true if a name in folder parent makes record r part of the
	// index. For a folder it also returns the path rules live inside it.
	accept := func(r, parent uint32, name string) (bool, []*pathRule) {
		if entries[r].flags&entryDir == 0 {
			return isDir(parent) && resolve(parent), nil
		}
		lower := strings.ToLower(name)
		if ix.excluded[lower] || (lower == "target" && cargo[parent]) {
			return false, nil
		}
		if !isDir(parent) || !resolve(parent) {
			return false, nil
		}
		rules, excluded := step(live[parent], lower)
		return !excluded, rules
	}
	resolve = func(r uint32) bool {
		switch state[r] {
		case stateIncluded:
			return true
		case stateExcluded, stateVisiting: // visiting = corrupt parent loop
			return false
		}
		state[r] = stateVisiting

		e := &entries[r]
		ok := false
		var rules []*pathRule
		switch {
		case r == rootRecord:
			ok = e.flags&entryInUse != 0
		case r < firstUserRecord || e.flags&entryInUse == 0 || e.nameLen == 0:
			ok = false
		default:
			if ok, rules = accept(r, e.parent, s.name(e.name, e.nameLen)); ok {
				break
			}
			// A hard link: fall back to another name that's in an indexed folder.
			for _, l := range s.links[r] {
				if ok, rules = accept(r, l.parent, s.name(l.name, l.nameLen)); ok {
					e.parent, e.name, e.nameLen = l.parent, l.name, l.nameLen
					break
				}
			}
		}

		if ok {
			state[r] = stateIncluded
			if len(rules) > 0 {
				live[r] = rules
			}
		} else {
			state[r] = stateExcluded
		}
		return ok
	}

	var written int64
	total := int64(len(entries))
	for i := range entries {
		r := uint32(i)
		if !resolve(r) {
			continue
		}
		e := &entries[r]
		f := database.File{
			ID:         base | int64(r),
			Name:       s.name(e.name, e.nameLen),
			IsDir:      e.flags&entryDir != 0,
			Size:       e.size,
			ModifiedAt: int64(e.mtime),
		}
		if r == rootRecord {
			f.Name = drive
		} else {
			f.ParentID = base | int64(e.parent)
		}
		if f.IsDir {
			f.Size = 0
		}
		if err := bulk.Add(f); err != nil {
			return written, err
		}
		written++
		if written%100_000 == 0 {
			ix.onProgress(Progress{Drive: drive, Phase: "saving", Done: int64(i), Total: total})
		}
	}
	ix.onProgress(Progress{Drive: drive, Phase: "saving", Done: total, Total: total})
	return written, nil
}

func fixedDrives() ([]string, error) {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil, err
	}
	var drives []string
	for i := 0; i < 26; i++ {
		if mask&(1<<i) == 0 {
			continue
		}
		d := string(rune('A'+i)) + ":"
		root, _ := windows.UTF16PtrFromString(d + `\`)
		if windows.GetDriveType(root) == windows.DRIVE_FIXED {
			drives = append(drives, d)
		}
	}
	return drives, nil
}
