package images

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// image writes a file big enough to be read (over minSize).
func image(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte{1}, minSize+1), 0o644); err != nil {
		t.Fatal(err)
	}
}

func paths(imgs []Image) []string {
	var out []string
	for _, i := range imgs {
		out = append(out, filepath.Base(i.Path))
	}
	return out
}

func TestPendingAddSearch(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	notes := filepath.Join(dir, "notes")
	image(t, filepath.Join(notes, "quiz.png"))
	image(t, filepath.Join(notes, "sub", "Photo.JPG"))
	image(t, filepath.Join(notes, "node_modules", "logo.png"))          // skipped folder
	os.WriteFile(filepath.Join(notes, "tiny.png"), []byte{1, 2}, 0o644) // too small
	os.WriteFile(filepath.Join(notes, "notes.txt"), bytes.Repeat([]byte{1}, minSize+1), 0o644)
	skip := func(p string, isDir bool) bool { return isDir && filepath.Base(p) == "node_modules" }

	s := New(filepath.Join(dir, "images.db"))
	defer s.Close()
	pending, err := s.Pending(ctx, []string{notes}, skip)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(paths(pending), ","); got != "quiz.png,Photo.JPG" && got != "Photo.JPG,quiz.png" {
		t.Fatalf("pending: %s", got)
	}

	for i := range pending {
		if filepath.Base(pending[i].Path) == "quiz.png" {
			pending[i].Text = "Which cloud capability provides the best solution? Elasticity"
		}
	}
	if err := s.Add(ctx, pending); err != nil {
		t.Fatal(err)
	}

	// Read, so nothing is pending until a file changes.
	if again, _ := s.Pending(ctx, []string{notes}, skip); len(again) != 0 {
		t.Errorf("pending after add: %v", paths(again))
	}
	later := time.Now().Add(time.Hour)
	os.Chtimes(filepath.Join(notes, "quiz.png"), later, later)
	if again, _ := s.Pending(ctx, []string{notes}, skip); strings.Join(paths(again), ",") != "quiz.png" {
		t.Errorf("pending after change: %v", paths(again))
	}

	for q, want := range map[string]int{"elasticity": 1, "cloud capab": 1, "ELASTIC": 1, "elasticity banana": 0, "'; --": 0, "": 0} {
		got, err := s.Search(ctx, q, 10)
		if err != nil {
			t.Errorf("%q: %v", q, err)
		}
		if len(got) != want {
			t.Errorf("%q: %d results, want %d", q, len(got), want)
		}
	}

	st, err := s.Stats(ctx)
	if err != nil || !st.Exists || st.Images != 2 || st.WithText != 1 || st.Bytes == 0 {
		t.Errorf("stats %+v, %v", st, err)
	}

	// A folder dropped from the list takes its images with it.
	if _, err := s.Pending(ctx, nil, skip); err != nil {
		t.Fatal(err)
	}
	if st, _ := s.Stats(ctx); st.Images != 0 {
		t.Errorf("after dropping the folder: %d images", st.Images)
	}
}

func TestSearchWithoutStoreMakesNone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "images.db")
	s := New(path)
	if got, err := s.Search(context.Background(), "anything", 5); err != nil || got != nil {
		t.Errorf("got %v, %v", got, err)
	}
	if st, err := s.Stats(context.Background()); err != nil || st.Exists {
		t.Errorf("stats %+v, %v", st, err)
	}
	if _, err := os.Stat(path); err == nil {
		t.Error("searching created the store")
	}
}

func TestDelete(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := New(filepath.Join(dir, "images.db"))
	if err := s.Add(ctx, []Image{{Path: `C:\a.png`, MTime: 1, Size: 1, Text: "hello"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(); err != nil {
		t.Fatal(err)
	}
	left, _ := filepath.Glob(filepath.Join(dir, "images.db*"))
	if len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
	if got, _ := s.Search(ctx, "hello", 5); len(got) != 0 {
		t.Errorf("found after delete: %v", got)
	}
}
