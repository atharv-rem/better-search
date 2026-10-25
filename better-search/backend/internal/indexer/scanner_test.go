package indexer

import (
	"encoding/binary"
	"path/filepath"
	"testing"
	"unicode/utf16"

	"better-search/backend/internal/database"
)

func TestParseRuns(t *testing.T) {
	// 0x18 clusters at LCN 0x5634, then 5 clusters 5 back (negative offset), then sparse.
	runs, err := parseRuns([]byte{0x21, 0x18, 0x34, 0x56, 0x11, 0x05, 0xFB, 0x01, 0x07, 0x00})
	if err != nil {
		t.Fatal(err)
	}
	want := []run{{0x5634, 0x18}, {0x5634 - 5, 5}, {-1, 7}}
	if len(runs) != len(want) {
		t.Fatalf("got %v", runs)
	}
	for i := range want {
		if runs[i] != want[i] {
			t.Fatalf("run %d: got %v, want %v", i, runs[i], want[i])
		}
	}
}

// set puts an entry in place, for tests that build a scan by hand.
func (s *mftScan) set(rec, parent uint32, flags uint8, name string) {
	off := len(s.names)
	s.names = append(s.names, name...)
	s.entries[rec] = entry{parent: parent, flags: flags, name: uint32(off), nameLen: uint16(len(name))}
}

func (s *mftScan) addLink(rec, parent uint32, name string) {
	off := len(s.names)
	s.names = append(s.names, name...)
	s.links[rec] = append(s.links[rec], link{parent, uint32(off), uint16(len(name))})
}

// appendName must decode exactly as utf16.Decode did, broken pairs included.
func TestAppendName(t *testing.T) {
	for _, units := range [][]uint16{
		utf16.Encode([]rune("Resume.pdf")),
		utf16.Encode([]rune("résumé 履歴書 😀.txt")),
		{0xD83D},               // lone high surrogate
		{0xDE00, 0x41},         // lone low surrogate
		{0xD83D, 0x41, 0xDE00}, // high, then not a low one
		{0x41, 0xD83D},         // high surrogate at the end
		{},
	} {
		b := make([]byte, len(units)*2)
		for i, u := range units {
			binary.LittleEndian.PutUint16(b[i*2:], u)
		}
		s := &mftScan{}
		off, n := s.appendName(b)
		if got, want := s.name(off, n), string(utf16.Decode(units)); got != want {
			t.Errorf("%x: got %q, want %q", units, got, want)
		}
	}
}

type fakeAttr struct {
	typ  uint32
	body []byte // full attribute bytes from offset 16 onward
	name bool   // named stream
}

func resident(typ uint32, value []byte) fakeAttr {
	b := make([]byte, 8+len(value))
	binary.LittleEndian.PutUint32(b[0:], uint32(len(value)))
	binary.LittleEndian.PutUint16(b[4:], 24) // value offset from attribute start
	copy(b[8:], value)
	return fakeAttr{typ: typ, body: b}
}

func fileName(parent uint64, name string, ns byte) fakeAttr {
	u := utf16.Encode([]rune(name))
	v := make([]byte, 66+len(u)*2)
	binary.LittleEndian.PutUint64(v[0:], parent|(1<<48)) // sequence number in the high bits
	v[64] = byte(len(u))
	v[65] = ns
	for i, c := range u {
		binary.LittleEndian.PutUint16(v[66+i*2:], c)
	}
	return resident(attrFileName, v)
}

// record builds a 1024-byte MFT record with valid fixups.
func record(flags uint16, base uint64, attrs ...fakeAttr) []byte {
	rec := make([]byte, 1024)
	le := binary.LittleEndian
	copy(rec, "FILE")
	le.PutUint16(rec[4:], 48) // update sequence array offset
	le.PutUint16(rec[6:], 3)  // check value + 2 sectors
	le.PutUint16(rec[20:], 56)
	le.PutUint16(rec[22:], flags)
	le.PutUint64(rec[32:], base)

	off := 56
	for _, a := range attrs {
		alen := (16 + len(a.body) + 7) &^ 7
		le.PutUint32(rec[off:], a.typ)
		le.PutUint32(rec[off+4:], uint32(alen))
		if a.typ == attrData && len(a.body) >= 48 {
			rec[off+8] = 1 // non-resident
		}
		if a.name {
			rec[off+9] = 1
		}
		copy(rec[off+16:], a.body)
		off += alen
	}
	le.PutUint32(rec[off:], attrEnd)
	le.PutUint32(rec[24:], uint32(off+8))

	// Fixups: stash each sector's last 2 bytes and replace them with the check value.
	le.PutUint16(rec[48:], 0x0042)
	for i := 1; i <= 2; i++ {
		pos := i*512 - 2
		copy(rec[48+i*2:], rec[pos:pos+2])
		le.PutUint16(rec[pos:], 0x0042)
	}
	return rec
}

func nonResidentData(size uint64) fakeAttr {
	b := make([]byte, 48)
	binary.LittleEndian.PutUint64(b[32:], size) // real size at attribute offset 48
	return fakeAttr{typ: attrData, body: b}
}

func stdInfo(unix int64) fakeAttr {
	v := make([]byte, 48)
	binary.LittleEndian.PutUint64(v[8:], uint64(unix+11_644_473_600)*10_000_000)
	return resident(attrStandardInfo, v)
}

func TestParseRecord(t *testing.T) {
	s := &mftScan{entries: make([]entry, 64), links: map[uint32][]link{}}

	s.parseRecord(record(recordInUse, 0,
		stdInfo(1_700_000_000),
		fileName(5, "RESUME~1.PDF", namespaceDOS),
		fileName(5, "Resume.pdf", 1),
		nonResidentData(123456),
		fakeAttr{typ: attrData, body: make([]byte, 8), name: true}, // Zone.Identifier stream
	), 40)

	e := s.entries[40]
	if s.name(e.name, e.nameLen) != "Resume.pdf" || e.parent != 5 || e.size != 123456 || e.mtime != 1_700_000_000 || e.flags != entryInUse {
		t.Fatalf("got %+v", e)
	}

	// Extension record pointing back at record 41 carries its second hard link.
	s.parseRecord(record(recordInUse|recordDirectory, 0, fileName(5, "Docs", 1)), 41)
	s.parseRecord(record(recordInUse, 41, fileName(30, "Docs-link", 1)), 42)
	if s.entries[41].flags != entryInUse|entryDir || len(s.links[41]) != 1 || s.name(s.links[41][0].name, s.links[41][0].nameLen) != "Docs-link" {
		t.Fatalf("extension merge: %+v %+v", s.entries[41], s.links[41])
	}

	// Torn write: a sector whose check value doesn't match is rejected.
	bad := record(recordInUse, 0, fileName(5, "torn.txt", 1))
	bad[1022] ^= 0xFF
	s.parseRecord(bad, 43)
	if s.entries[43].nameLen != 0 {
		t.Fatal("torn record was accepted")
	}
}

func TestSaveSkipsExcludedAndOrphans(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	dir := entryInUse | entryDir
	s := &mftScan{entries: make([]entry, 30), links: map[uint32][]link{}}
	s.set(5, 5, dir, ".")
	s.set(11, 5, dir, "$Extend") // metadata, skipped
	s.set(16, 11, entryInUse, "$UsnJrnl")
	s.set(17, 5, dir, "Windows")
	s.set(18, 17, dir, "WinSxS")
	s.set(19, 18, entryInUse, "notepad.exe")
	s.addLink(19, 20, "notepad.exe") // hard link also in System32
	s.set(20, 17, dir, "System32")
	s.set(21, 25, entryInUse, "orphan.txt") // parent not in use
	s.set(22, 23, dir, "loopA")
	s.set(23, 22, dir, "loopB")

	ix := New(nil, DefaultExcludedDirs, DefaultExcludedPaths, nil)
	b, err := db.BeginBulk()
	if err != nil {
		t.Fatal(err)
	}
	n, err := ix.save(b, s, "C:", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Commit(); err != nil {
		t.Fatal(err)
	}
	// C:, Windows, System32, notepad.exe
	if n != 4 {
		t.Fatalf("wrote %d rows, want 4", n)
	}
	got, err := db.SearchNames("notepad", []string{"notepad"}, 5)
	if err != nil || len(got) != 1 {
		t.Fatalf("notepad: %v %v", got, err)
	}
	if p, _ := db.Path(got[0]); p != `C:\Windows\System32\notepad.exe` {
		t.Fatalf("hard link should resolve outside WinSxS, got %q", p)
	}
}

func TestSaveSkipsExcludedPaths(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	dir := entryInUse | entryDir
	file := entryInUse
	s := &mftScan{entries: make([]entry, 60), links: map[uint32][]link{}}
	s.set(5, 5, dir, ".")
	s.set(16, 5, dir, "Users")
	s.set(17, 16, dir, "bob")
	s.set(18, 17, dir, "AppData")
	s.set(19, 18, dir, "Local")
	s.set(20, 19, dir, "packages") // Users\*\AppData\Local\Packages
	s.set(21, 20, file, "inside-packages.txt")
	s.set(22, 19, dir, "Keep")
	s.set(23, 22, file, "kept-local.txt")
	s.set(24, 18, dir, "Roaming")
	s.set(25, 24, dir, "zen")
	s.set(26, 25, dir, "Profiles")
	s.set(27, 26, dir, "abc.default")
	s.set(28, 27, dir, "storage") // ...\Profiles\*\storage
	s.set(29, 28, file, "blob.final")
	s.set(30, 27, file, "prefs.js")
	s.set(31, 5, dir, "Packages") // not under AppData\Local: kept
	s.set(32, 31, file, "kept-root.txt")
	s.set(33, 17, dir, "rusty")
	s.set(34, 33, file, "Cargo.toml")
	s.set(35, 33, dir, "target") // next to Cargo.toml
	s.set(36, 35, file, "build-output.rlib")
	s.set(37, 17, dir, "target") // no Cargo.toml: kept
	s.set(38, 37, file, "kept-target.txt")
	s.set(39, 22, dir, "Code Cache")
	s.set(40, 39, file, "inside-cache.bin")
	s.set(41, 24, dir, "Code")
	s.set(42, 41, dir, "User")
	s.set(43, 42, dir, "History") // Roaming\*\User\History
	s.set(44, 43, file, "snapshot.ts")
	s.set(45, 42, file, "settings.json")

	ix := New(nil, DefaultExcludedDirs, DefaultExcludedPaths, nil)
	b, err := db.BeginBulk()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ix.save(b, s, "C:", 0); err != nil {
		t.Fatal(err)
	}
	if err := b.Commit(); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]bool{
		"kept-local.txt": true, "prefs.js": true, "kept-root.txt": true, "kept-target.txt": true, "Cargo.toml": true,
		"settings.json":       true,
		"inside-packages.txt": false, "blob.final": false, "build-output.rlib": false, "inside-cache.bin": false,
		"snapshot.ts": false,
	} {
		got, err := db.SearchNames(name, []string{name}, 5)
		if err != nil {
			t.Fatal(err)
		}
		if (len(got) > 0) != want {
			t.Errorf("%s indexed = %v, want %v", name, len(got) > 0, want)
		}
	}
}
