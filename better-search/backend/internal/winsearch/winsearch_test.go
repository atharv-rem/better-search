package winsearch

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestBuildSQLWords(t *testing.T) {
	sql, ok := buildSQL("  fact   notes ", 20)
	if !ok {
		t.Fatal("no query for two words")
	}
	for _, want := range []string{
		"SELECT TOP 20 System.ItemPathDisplay",
		"SCOPE='file:'",
		`CONTAINS(System.Search.Contents,'"fact*" AND "notes*"')`,
		"ORDER BY System.Search.Rank DESC",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("%s\nmissing %s", sql, want)
		}
	}
}

func TestBuildSQLNoWords(t *testing.T) {
	for _, q := range []string{"", "   ", `"" **`, "'; --"} {
		if sql, ok := buildSQL(q, 20); ok {
			t.Errorf("%q: got %s", q, sql)
		}
	}
}

func TestBuildSQLEscapes(t *testing.T) {
	sql, _ := buildSQL(`don't "quoted" ab*c x'); DROP '; 50%_off`, 20)
	want := `'"don''t*" AND "quoted*" AND "ab*" AND "c*" AND "x*" AND "DROP*" AND "50*" AND "off*"'`
	if !strings.Contains(sql, want) {
		t.Errorf("%s\nmissing %s", sql, want)
	}
}

func TestWords(t *testing.T) {
	for q, want := range map[string]string{
		"fact notes":     "fact|notes",
		"résumé 2024":    "résumé|2024",
		"don't ’quoted’": "don't|quoted",
		"'; -- [x] ''":   "x",
		`C:\a_b.pdf`:     "C|a|b|pdf",
		"日本語 テスト":        "日本語|テスト",
	} {
		if got := strings.Join(words(q), "|"); got != want {
			t.Errorf("%q: got %q, want %q", q, got, want)
		}
	}
}

func TestBuildSQLCapsWords(t *testing.T) {
	sql, _ := buildSQL(strings.Repeat("word ", 20), 5)
	if n := strings.Count(sql, `"word*"`); n != maxWords {
		t.Errorf("%d words, want %d", n, maxWords)
	}
}

func TestSplitRows(t *testing.T) {
	got := splitRows("C:\\a b.pdf\t\nC:\\c.txt\t\n\n")
	if len(got) != 2 || got[0] != `C:\a b.pdf` || got[1] != `C:\c.txt` {
		t.Errorf("got %q", got)
	}
	if got := splitRows(""); len(got) != 0 {
		t.Errorf("empty: got %q", got)
	}
}

// Against this machine's Windows Search; skipped where it's off.
func TestSearchLive(t *testing.T) {
	s := New()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	paths, err := s.Search(ctx, "the", 10)
	if errors.Is(err, ErrUnavailable) {
		t.Skip(err)
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range paths {
		if len(p) < 3 || p[1] != ':' {
			t.Errorf("not a file path: %q", p)
		}
		if strings.Contains(strings.ToLower(p), `\node_modules\`) {
			t.Errorf("node_modules not left out: %q", p)
		}
	}
	if none, err := s.Search(ctx, "zqxjvwkq", 10); err != nil || len(none) != 0 {
		t.Errorf("nonsense word: %q, %v", none, err)
	}

	// Released, the next query opens a new connection.
	s.Release()
	if _, err := s.Search(ctx, "the", 5); err != nil {
		t.Errorf("after release: %v", err)
	}

	// A cancelled query returns at once.
	done, stop := context.WithCancel(context.Background())
	stop()
	if _, err := s.Search(done, "the", 5); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
}
