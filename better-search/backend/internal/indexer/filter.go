package indexer

import (
	"os"
	"strings"
	"time"
)

// FixedDrives lists the fixed drives, like "C:".
func FixedDrives() ([]string, error) { return fixedDrives() }

// Excluded reports whether the index leaves out a full path like
// C:\Users\me\node_modules\a.js, by the same rules a full index uses: the
// default and user exclusions, and Rust's "target" folders. isDir says what
// the last part of the path is, as names only exclude folders.
func (ix *Indexer) Excluded(path string, isDir bool) bool {
	if len(path) < 3 || path[1] != ':' {
		return true
	}
	drive := strings.ToUpper(path[:2])
	if ix.skipDrives[drive] {
		return true
	}

	parts := strings.Split(strings.Trim(path[2:], `\`), `\`)
	live := ix.rootRules(drive)
	for i, part := range parts {
		if part == "" {
			continue
		}
		if i == len(parts)-1 && !isDir {
			return false
		}
		lower := strings.ToLower(part)
		if ix.excluded[lower] {
			return true
		}
		if lower == "target" && ix.hasCargoToml(path[:2]+`\`+strings.Join(parts[:i], `\`)) {
			return true
		}
		var excluded bool
		if live, excluded = step(live, lower); excluded {
			return true
		}
	}
	return false
}

// How long hasCargoToml trusts what it last saw in a folder, and how many
// folders it remembers.
const (
	cargoTTL   = time.Minute
	cargoLimit = 1000
)

type cargoSeen struct {
	has bool
	at  time.Time
}

// hasCargoToml reports whether dir holds a Cargo.toml. A build writes
// thousands of files into target, and each change is checked here, so the
// answer is remembered for a while rather than looked up on disk every time.
func (ix *Indexer) hasCargoToml(dir string) bool {
	key := strings.ToLower(strings.TrimRight(dir, `\`))
	ix.cargoMu.Lock()
	defer ix.cargoMu.Unlock()
	if seen, ok := ix.cargo[key]; ok && time.Since(seen.at) < cargoTTL {
		return seen.has
	}
	_, err := os.Stat(key + `\Cargo.toml`)
	if ix.cargo == nil || len(ix.cargo) >= cargoLimit {
		ix.cargo = map[string]cargoSeen{}
	}
	ix.cargo[key] = cargoSeen{has: err == nil, at: time.Now()}
	return err == nil
}
