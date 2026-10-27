package search

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreferShortcuts(t *testing.T) {
	menu := `C:\ProgramData\Microsoft\Windows\Start Menu\Programs\`
	in := []Result{
		{Name: "spotify.png", Path: `C:\Icons\spotify.png`},
		{Name: "Spotify.exe", Path: `C:\Users\me\AppData\Roaming\Spotify\Spotify.exe`},
		{Name: "notes.txt", Path: `C:\Users\me\notes.txt`},
		{Name: "Spotify.exe", Path: `C:\Old\Spotify.exe`},
		{Name: "Spotify.lnk", Path: menu + `Spotify.lnk`},
		{Name: "Spotify.lnk", Path: `C:\Users\me\Links\Spotify.lnk`}, // not an app shortcut
		{Name: "Sticky.lnk", Path: menu + `Sticky.lnk`},
		{Name: "Spotify.lnk", Path: menu + `Spotify Inc\Spotify.lnk`}, // the same again
	}
	want := []string{
		menu + `Spotify.lnk`,
		`C:\Icons\spotify.png`,
		`C:\Users\me\notes.txt`,
		`C:\Users\me\Links\Spotify.lnk`,
		menu + `Sticky.lnk`,
	}
	got := preferShortcuts(in, "spotify")
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i].Path != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

// Reads the targets of this machine's Start menu shortcuts: every one that
// points at an .exe should read as a path to it.
func TestParseLinkTarget(t *testing.T) {
	root := filepath.Join(os.Getenv("ProgramData"), `Microsoft\Windows\Start Menu\Programs`)
	var exes int
	filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".lnk") {
			return nil
		}
		target := shortcutTarget(path)
		if strings.HasSuffix(target, ".exe") {
			exes++
			if len(target) < 3 || target[1] != ':' {
				t.Errorf("%s: target %q", path, target)
			}
		}
		return nil
	})
	if exes == 0 {
		t.Skip("no Start menu shortcuts to an .exe here")
	}
	t.Logf("read %d shortcut targets", exes)
}
