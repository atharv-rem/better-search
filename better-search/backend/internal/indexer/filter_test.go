package indexer

import "testing"

// The app's own data and Phone Link's view of a phone stay out of the index,
// the files the watcher and the results check one at a time included.
func TestExcludedOwnDataAndPhones(t *testing.T) {
	ix := New(nil, DefaultExcludedDirs, DefaultExcludedPaths, nil)
	for path, want := range map[string]bool{
		`C:\Users\me\AppData\Local\better-search\index.db`:              true,
		`D:\better-search-data\index.db`:                                true,
		`C:\Users\me\CrossDevice\Pixel 8\storage\Download\Me.pdf`:       true,
		`C:\Users\me\Documents\CrossDevice\notes.txt`:                   false, // only the one Phone Link makes
		`C:\Users\me\Documents\better-search\notes.txt`:                 false,
		`C:\Users\me\Downloads\better-search\better-search\src\App.tsx`: false,
	} {
		if got := ix.Excluded(path, false); got != want {
			t.Errorf("Excluded(%s) = %v, want %v", path, got, want)
		}
	}
}
