package search

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

// preferShortcuts puts apps' Start menu and desktop shortcuts first: a
// shortcut is how an app is meant to be started, with the arguments and
// working folder its .exe may need (Discord's runs Update.exe --processStart
// Discord.exe). Shortcuts named for the query ("Discord", "Visual Studio
// Code") lead the results; any other takes the place of the first .exe it
// stands for: one it points to, or one of the same name. Those .exe files,
// and shortcuts repeating one already shown by name, are left out.
func preferShortcuts(results []Result, query string) []Result {
	byName := map[string]int{}   // lower-cased name without extension -> shortcut
	byTarget := map[string]int{} // lower-cased target path -> shortcut
	for i, r := range results {
		if !isAppShortcut(r.Path) {
			continue
		}
		if _, ok := byName[stem(r.Name)]; !ok {
			byName[stem(r.Name)] = i
		}
		if target := shortcutTarget(r.Path); target != "" {
			if _, ok := byTarget[target]; !ok {
				byTarget[target] = i
			}
		}
	}
	if len(byName) == 0 {
		return results
	}

	shown := map[string]bool{} // shortcut names already in out
	add := func(out []Result, i int) []Result {
		if name := stem(results[i].Name); !shown[name] {
			shown[name] = true
			out = append(out, results[i])
		}
		return out
	}

	q := strings.ToLower(strings.TrimSpace(query))
	out := make([]Result, 0, len(results))
	for i, r := range results {
		if name := stem(r.Name); isAppShortcut(r.Path) && (strings.HasPrefix(name, q) || strings.Contains(name, " "+q)) {
			out = add(out, i)
		}
	}
	for i, r := range results {
		switch {
		case isAppShortcut(r.Path):
			out = add(out, i)
		case strings.EqualFold(filepath.Ext(r.Name), ".exe"):
			s, ok := byTarget[strings.ToLower(r.Path)]
			if !ok {
				s, ok = byName[stem(r.Name)]
			}
			if ok {
				out = add(out, s)
			} else {
				out = append(out, r)
			}
		default:
			out = append(out, r)
		}
	}
	return out
}

// isAppShortcut reports whether path is a shortcut in a Start menu or on a
// desktop, where installers put the ones that start an app.
func isAppShortcut(path string) bool {
	lower := strings.ToLower(path)
	return strings.HasSuffix(lower, ".lnk") &&
		(strings.Contains(lower, `\start menu\programs\`) || strings.Contains(lower, `\desktop\`))
}

// stem is a name without its extension, lower-cased: "Spotify.lnk" -> "spotify".
func stem(name string) string {
	return strings.ToLower(strings.TrimSuffix(name, filepath.Ext(name)))
}

// shortcutTarget reads the local path a .lnk file points to, lower-cased, or
// "" when it has none (a shortcut to a store app or a Windows Installer
// "advertised" one) or can't be read.
func shortcutTarget(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.ToLower(parseLinkTarget(data))
}

// Shell link format (MS-SHLLINK): a 0x4C-byte header, then an optional item
// ID list, then an optional LinkInfo, which holds the target's local path.
const (
	linkHeaderSize      = 0x4C
	hasLinkTargetIDList = 0x1
	hasLinkInfo         = 0x2
	volumeIDAndBasePath = 0x1
)

func parseLinkTarget(data []byte) string {
	if len(data) < linkHeaderSize || binary.LittleEndian.Uint32(data) != linkHeaderSize {
		return ""
	}
	flags := binary.LittleEndian.Uint32(data[0x14:])
	off := linkHeaderSize
	if flags&hasLinkTargetIDList != 0 {
		if len(data) < off+2 {
			return ""
		}
		off += 2 + int(binary.LittleEndian.Uint16(data[off:]))
	}
	if flags&hasLinkInfo == 0 || len(data) < off+28 {
		return ""
	}
	info := data[off:]
	size := int(binary.LittleEndian.Uint32(info))
	if size > len(info) || size < 28 {
		return ""
	}
	info = info[:size]
	headerSize := binary.LittleEndian.Uint32(info[4:])
	if binary.LittleEndian.Uint32(info[8:])&volumeIDAndBasePath == 0 {
		return ""
	}
	// Newer links also carry the path as UTF-16, which keeps non-ASCII names.
	if headerSize >= 0x24 && len(info) >= 0x24 {
		base := utf16At(info, int(binary.LittleEndian.Uint32(info[0x1C:])))
		suffix := utf16At(info, int(binary.LittleEndian.Uint32(info[0x20:])))
		if base != "" {
			return base + suffix
		}
	}
	base := cStringAt(info, int(binary.LittleEndian.Uint32(info[0x10:])))
	suffix := cStringAt(info, int(binary.LittleEndian.Uint32(info[0x18:])))
	return base + suffix
}

func cStringAt(b []byte, off int) string {
	if off <= 0 || off >= len(b) {
		return ""
	}
	b = b[off:]
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return ""
}

func utf16At(b []byte, off int) string {
	if off <= 0 || off >= len(b) {
		return ""
	}
	var u []uint16
	for i := off; i+1 < len(b); i += 2 {
		c := binary.LittleEndian.Uint16(b[i:])
		if c == 0 {
			return string(utf16.Decode(u))
		}
		u = append(u, c)
	}
	return ""
}
