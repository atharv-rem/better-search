package indexer

import (
	"os"
	"strings"
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
		if lower == "target" && hasCargoToml(path[:2]+`\`+strings.Join(parts[:i], `\`)) {
			return true
		}
		var excluded bool
		if live, excluded = step(live, lower); excluded {
			return true
		}
	}
	return false
}

func hasCargoToml(dir string) bool {
	_, err := os.Stat(strings.TrimRight(dir, `\`) + `\Cargo.toml`)
	return err == nil
}
