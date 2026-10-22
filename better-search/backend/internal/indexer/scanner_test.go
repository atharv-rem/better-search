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
	if e.name != "Resume.pdf" || e.parent != 5 || e.size != 123456 || e.mtime != 1_700_000_000 || e.flags != entryInUse {
		t.Fatalf("got %+v", e)
	}

	// Extension record pointing back at record 41 carries its second hard link.
	s.parseRecord(record(recordInUse|recordDirectory, 0, fileName(5, "Docs", 1)), 41)
	s.parseRecord(record(recordInUse, 41, fileName(30, "Docs-link", 1)), 42)
	if s.entries[41].flags != entryInUse|entryDir || len(s.links[41]) != 1 || s.links[41][0].name != "Docs-link" {
		t.Fatalf("extension merge: %+v %+v", s.entries[41], s.links[41])
	}

	// Torn write: a sector whose check value doesn't match is rejected.
	bad := record(recordInUse, 0, fileName(5, "torn.txt", 1))
	bad[1022] ^= 0xFF
	s.parseRecord(bad, 43)
	if s.entries[43].name != "" {
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
	s.entries[5] = entry{parent: 5, flags: dir, name: "."}
	s.entries[11] = entry{parent: 5, flags: dir, name: "$Extend"} // metadata, skipped
	s.entries[16] = entry{parent: 11, flags: entryInUse, name: "$UsnJrnl"}
	s.entries[17] = entry{parent: 5, flags: dir, name: "Windows"}
	s.entries[18] = entry{parent: 17, flags: dir, name: "WinSxS"}
	s.entries[19] = entry{parent: 18, flags: entryInUse, name: "notepad.exe"}
	s.links[19] = []link{{parent: 20, name: "notepad.exe"}} // hard link also in System32
	s.entries[20] = entry{parent: 17, flags: dir, name: "System32"}
	s.entries[21] = entry{parent: 25, flags: entryInUse, name: "orphan.txt"} // parent not in use
	s.entries[22] = entry{parent: 23, flags: dir, name: "loopA"}
	s.entries[23] = entry{parent: 22, flags: dir, name: "loopB"}

	ix := New(db, DefaultExcludedDirs, DefaultExcludedPaths, nil)
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
	s.entries[5] = entry{parent: 5, flags: dir, name: "."}
	s.entries[16] = entry{parent: 5, flags: dir, name: "Users"}
	s.entries[17] = entry{parent: 16, flags: dir, name: "bob"}
	s.entries[18] = entry{parent: 17, flags: dir, name: "AppData"}
	s.entries[19] = entry{parent: 18, flags: dir, name: "Local"}
	s.entries[20] = entry{parent: 19, flags: dir, name: "packages"} // Users\*\AppData\Local\Packages
	s.entries[21] = entry{parent: 20, flags: file, name: "inside-packages.txt"}
	s.entries[22] = entry{parent: 19, flags: dir, name: "Keep"}
	s.entries[23] = entry{parent: 22, flags: file, name: "kept-local.txt"}
	s.entries[24] = entry{parent: 18, flags: dir, name: "Roaming"}
	s.entries[25] = entry{parent: 24, flags: dir, name: "zen"}
	s.entries[26] = entry{parent: 25, flags: dir, name: "Profiles"}
	s.entries[27] = entry{parent: 26, flags: dir, name: "abc.default"}
	s.entries[28] = entry{parent: 27, flags: dir, name: "storage"} // ...\Profiles\*\storage
	s.entries[29] = entry{parent: 28, flags: file, name: "blob.final"}
	s.entries[30] = entry{parent: 27, flags: file, name: "prefs.js"}
	s.entries[31] = entry{parent: 5, flags: dir, name: "Packages"} // not under AppData\Local: kept
	s.entries[32] = entry{parent: 31, flags: file, name: "kept-root.txt"}
	s.entries[33] = entry{parent: 17, flags: dir, name: "rusty"}
	s.entries[34] = entry{parent: 33, flags: file, name: "Cargo.toml"}
	s.entries[35] = entry{parent: 33, flags: dir, name: "target"} // next to Cargo.toml
	s.entries[36] = entry{parent: 35, flags: file, name: "build-output.rlib"}
	s.entries[37] = entry{parent: 17, flags: dir, name: "target"} // no Cargo.toml: kept
	s.entries[38] = entry{parent: 37, flags: file, name: "kept-target.txt"}
	s.entries[39] = entry{parent: 22, flags: dir, name: "Code Cache"}
	s.entries[40] = entry{parent: 39, flags: file, name: "inside-cache.bin"}
	s.entries[41] = entry{parent: 24, flags: dir, name: "Code"}
	s.entries[42] = entry{parent: 41, flags: dir, name: "User"}
	s.entries[43] = entry{parent: 42, flags: dir, name: "History"} // Roaming\*\User\History
	s.entries[44] = entry{parent: 43, flags: file, name: "snapshot.ts"}
	s.entries[45] = entry{parent: 42, flags: file, name: "settings.json"}

	ix := New(db, DefaultExcludedDirs, DefaultExcludedPaths, nil)
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
