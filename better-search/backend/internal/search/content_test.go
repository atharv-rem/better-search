package search

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"better-search/backend/internal/database"
	"better-search/backend/internal/winsearch"
)

// Against this machine's Windows Search, with an empty index: every file it
// finds is checked on disk instead. Skipped where Windows Search is off.
func TestContentLive(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ws := winsearch.New()

	all, err := Content(ctx, db, ws, "the", 10, nil)
	if errors.Is(err, winsearch.ErrUnavailable) {
		t.Skip(err)
	}
	if err != nil {
		t.Fatal(err)
	}
	if len(all) == 0 {
		t.Skip("Windows Search has no file containing \"the\"")
	}
	if len(all) > 10 {
		t.Errorf("%d results for a limit of 10", len(all))
	}
	for _, r := range all {
		if r.ID != 0 || r.Type != "file" || r.Name != filepath.Base(r.Path) || r.ModifiedAt == 0 {
			t.Errorf("result %+v", r)
		}
	}

	// Leaving out the first result's folder leaves out everything in it.
	dir := filepath.Dir(all[0].Path) + `\`
	skip := func(path string, _ bool) bool { return strings.HasPrefix(path, dir) }
	kept, err := Content(ctx, db, ws, "the", 10, skip)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range kept {
		if strings.HasPrefix(r.Path, dir) {
			t.Errorf("skipped folder's file kept: %s", r.Path)
		}
	}

	if none, err := Content(ctx, db, ws, "", 10, nil); err != nil || len(none) != 0 {
		t.Errorf("empty query: %v, %v", none, err)
	}
}
