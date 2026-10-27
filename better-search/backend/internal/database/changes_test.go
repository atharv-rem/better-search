package database

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// A damaged index where folder 51's parent chain loops (51 -> 52 -> 50 -> 51)
// and never reaches a drive, beside an ordinary file.
var looped = []File{
	{ID: 5, Name: "C:", IsDir: true},
	{ID: 20, ParentID: 5, Name: "Users", IsDir: true},
	{ID: 30, ParentID: 20, Name: "notes.txt"},
	{ID: 50, ParentID: 51, Name: "logo.png"},
	{ID: 51, ParentID: 52, Name: "window1", IsDir: true},
	{ID: 52, ParentID: 50, Name: "assets", IsDir: true},
	{ID: 53, ParentID: 52, Name: "readme.md"},
}

func TestPathsSurviveLoop(t *testing.T) {
	db := openTest(t)
	load(t, db, looped)
	paths, err := db.Paths(context.Background(), []File{
		{ID: 30, ParentID: 20, Name: "notes.txt"},
		{ID: 53, ParentID: 52, Name: "readme.md"},
		{ID: 5, Name: "C:"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{`C:\Users\notes.txt`, "", `C:\`}
	for i := range want {
		if paths[i] != want[i] {
			t.Fatalf("paths = %q, want %q", paths, want)
		}
	}
}

func TestDeleteTreeEndsOnLoop(t *testing.T) {
	db := openTest(t)
	load(t, db, looped)
	ch, err := db.BeginChanges()
	if err != nil {
		t.Fatal(err)
	}
	if err := ch.DeleteTree(51); err != nil {
		t.Fatal(err)
	}
	if err := ch.Commit(); err != nil {
		t.Fatal(err)
	}
	if got := names(t, db, "readme"); len(got) != 0 {
		t.Fatalf("rows inside the loop left behind: %v", got)
	}
}

// Windows gives a deleted folder's record to a new file: the folder's old
// contents in the index are stale and must go, not hang off the file.
func TestUpsertClearsFolderTurnedFile(t *testing.T) {
	for _, tc := range []struct {
		name string
		f    File
	}{
		{"record reused by a file", File{ID: 50, ParentID: 52, Name: "logo.png"}},
		{"folder moved below itself", File{ID: 50, ParentID: 52, Name: "old", IsDir: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := openTest(t)
			load(t, db, []File{
				{ID: 5, Name: "C:", IsDir: true},
				{ID: 50, ParentID: 5, Name: "old", IsDir: true},
				{ID: 51, ParentID: 50, Name: "window1", IsDir: true},
				{ID: 52, ParentID: 51, Name: "assets", IsDir: true},
				{ID: 53, ParentID: 52, Name: "readme.md"},
			})
			ch, err := db.BeginChanges()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ch.Upsert(tc.f); err != nil {
				t.Fatal(err)
			}
			for _, id := range []int64{51, 52} {
				if has, err := ch.HasDir(id); err != nil || has {
					t.Fatalf("stale folder %d still indexed (%v)", id, err)
				}
			}
			if err := ch.Commit(); err != nil {
				t.Fatal(err)
			}
			if got := names(t, db, "readme"); len(got) != 0 {
				t.Fatalf("stale file still indexed: %v", got)
			}
		})
	}
}

// A folder renamed or moved keeps what's inside it.
func TestUpsertKeepsMovedFolder(t *testing.T) {
	db := openTest(t)
	load(t, db, tree)
	ch, err := db.BeginChanges()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ch.Upsert(File{ID: 21, ParentID: 5, Name: "me", IsDir: true}); err != nil {
		t.Fatal(err)
	}
	if err := ch.Commit(); err != nil {
		t.Fatal(err)
	}
	if p, err := db.Path(File{ParentID: 21, Name: "Resume.pdf"}); err != nil || p != `C:\me\Resume.pdf` {
		t.Fatalf("path after move: %q, %v", p, err)
	}
}

func TestSearchCancelled(t *testing.T) {
	db := openTest(t)
	load(t, db, tree)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := db.SearchNames(ctx, "resume", []string{"resume"}, 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled search: err = %v", err)
	}
}

// Listing a folder's subfolders reads only the folder-only index, not the
// table rows of every file beside them.
func TestChildDirsUsesFolderIndex(t *testing.T) {
	db := openTest(t)
	load(t, db, looped)
	rows, err := db.sql.Query(`EXPLAIN QUERY PLAN SELECT id, name, modified_at FROM files WHERE parent_id = ? AND is_dir = 1`, 52)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		plan += detail + "; "
	}
	if !strings.Contains(plan, "COVERING INDEX files_child_dirs") {
		t.Fatalf("plan = %q", plan)
	}
	kids, err := db.ChildDirs(52)
	if err != nil {
		t.Fatal(err)
	}
	if len(kids) != 1 || kids[0].ID != 51 {
		t.Fatalf("ChildDirs(52) = %+v, want only window1 (51)", kids)
	}
}
