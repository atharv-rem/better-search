package indexer

import (
	"encoding/json"
	"os"
	"strings"
)

// Options are the user's indexing choices, from the "indexing" section of the
// app's settings.json (written by the Tauri shell, see lib.rs `Settings`).
type Options struct {
	// Drives not to index, like "D:".
	ExcludedDrives []string `json:"excluded_drives"`
	// Folders not to index: a full path ("D:\Archive") skips that one folder,
	// a bare name ("build") skips every folder called that, on every drive.
	ExcludedFolders []string `json:"excluded_folders"`
}

// LoadOptions reads the indexing options from settings.json. A missing or
// unreadable file means no options: index everything but the defaults.
func LoadOptions(settingsPath string) Options {
	var file struct {
		Indexing Options `json:"indexing"`
	}
	if settingsPath == "" {
		return Options{}
	}
	data, err := os.ReadFile(settingsPath)
	if err != nil || json.Unmarshal(data, &file) != nil {
		return Options{}
	}
	return file.Indexing
}

// Apply adds the user's exclusions to the indexer's built-in ones.
func (ix *Indexer) Apply(opts Options) {
	ix.skipDrives = map[string]bool{}
	for _, d := range opts.ExcludedDrives {
		ix.skipDrives[strings.ToUpper(strings.TrimRight(d, `\`))] = true
	}

	byDrive := map[string][]string{}
	for _, f := range opts.ExcludedFolders {
		f = strings.TrimRight(strings.TrimSpace(strings.ReplaceAll(f, "/", `\`)), `\`)
		switch {
		case f == "":
		case len(f) >= 2 && f[1] == ':':
			drive, rest := strings.ToUpper(f[:2]), strings.Trim(f[2:], `\`)
			if rest == "" {
				ix.skipDrives[drive] = true // the whole drive
			} else {
				byDrive[drive] = append(byDrive[drive], rest)
			}
		case strings.Contains(f, `\`):
			// No drive: a path from the root of every drive, like the defaults.
			byDrive[""] = append(byDrive[""], strings.Trim(f, `\`))
		default:
			ix.excluded[strings.ToLower(f)] = true
		}
	}

	ix.drivePaths = map[string]*pathRule{}
	for drive, paths := range byDrive {
		ix.drivePaths[drive] = compilePaths(paths)
	}
}

// rootRules are the path rules live at a drive's root folder.
func (ix *Indexer) rootRules(drive string) []*pathRule {
	rules := []*pathRule{ix.paths}
	for _, key := range [2]string{"", drive} {
		if r := ix.drivePaths[key]; r != nil {
			rules = append(rules, r)
		}
	}
	return rules
}
