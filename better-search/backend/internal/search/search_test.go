package search

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"better-search/backend/internal/database"
)

func TestSkipLeavesOutResultsAndKeepsTheLimit(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	b, err := db.BeginBulk()
	if err != nil {
		t.Fatal(err)
	}
	files := []database.File{
		{ID: 5, Name: "C:", IsDir: true},
		{ID: 20, ParentID: 5, Name: "Excluded", IsDir: true},
		{ID: 21, ParentID: 5, Name: "Kept", IsDir: true},
		{ID: 30, ParentID: 20, Name: "report1.txt"},
		{ID: 31, ParentID: 20, Name: "report2.txt"},
		{ID: 32, ParentID: 21, Name: "report3.txt"},
		{ID: 33, ParentID: 21, Name: "report4.txt"},
	}
	for _, f := range files {
		if err := b.Add(f); err != nil {
			t.Fatal(err)
		}
	}
	if err := b.Commit(); err != nil {
		t.Fatal(err)
	}

	skip := func(path string, _ bool) bool { return strings.HasPrefix(path, `C:\Excluded\`) }
	got, err := Search(context.Background(), db, "report", 2, skip)
	if err != nil {
		t.Fatal(err)
	}
	// Both excluded files would fill the limit; the kept ones take their place.
	if len(got) != 2 {
		t.Fatalf("got %d results, want 2: %v", len(got), got)
	}
	for _, r := range got {
		if !strings.HasPrefix(r.Path, `C:\Kept\`) {
			t.Fatalf("got %s, which skip leaves out", r.Path)
		}
	}

	all, err := Search(context.Background(), db, "report", 10, nil)
	if err != nil || len(all) != 4 {
		t.Fatalf("without skip: got %d results, %v; want 4", len(all), err)
	}
}
