package indexer

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
	"unicode/utf16"
	"unsafe"

	"better-search/backend/internal/database"

	"golang.org/x/sys/windows"
)

// A full index of a synthetic drive shaped like a real one: 2 million MFT
// records, 60% in use, most of those inside an excluded folder (WinSxS), a
// tenth of the records kept. Reports the scan's memory and the save's time.
//
//	BETTER_SEARCH_BENCH_INDEX=1 go test ./internal/indexer -run IndexBench -v
func TestIndexBench(t *testing.T) {
	if os.Getenv("BETTER_SEARCH_BENCH_INDEX") == "" {
		t.Skip("BETTER_SEARCH_BENCH_INDEX not set")
	}
	const records = 2_000_000

	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	start := time.Now()
	s := synthScan(records)
	scanTook := time.Since(start)
	var afterScan runtime.MemStats
	runtime.ReadMemStats(&afterScan)
	runtime.GC()
	var live runtime.MemStats
	runtime.ReadMemStats(&live)
	peak := peakPrivateBytes()

	db, err := database.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ix := New(db, DefaultExcludedDirs, DefaultExcludedPaths, nil)
	start = time.Now()
	bulk, err := db.BeginBulk()
	if err != nil {
		t.Fatal(err)
	}
	n, err := ix.save(bulk, s, "C:", 0)
	if err != nil {
		t.Fatal(err)
	}
	saveTook := time.Since(start)
	start = time.Now()
	if err := bulk.Commit(); err != nil {
		t.Fatal(err)
	}
	commitTook := time.Since(start)
	runtime.KeepAlive(s)

	mb := func(b uint64) float64 { return float64(b) / (1 << 20) }
	t.Logf("scan:   %v for %d records", scanTook.Round(time.Millisecond), records)
	t.Logf("        kept in memory after the scan:  %.0f MB", mb(live.HeapAlloc-before.HeapAlloc))
	t.Logf("        allocated in all during scan:   %.0f MB", mb(afterScan.TotalAlloc-before.TotalAlloc))
	t.Logf("        process peak (private bytes):   %.0f MB", mb(peak))
	t.Logf("save:   %v to work out and insert %d rows", saveTook.Round(time.Millisecond), n)
	t.Logf("commit: %v (lookup tables, search index)", commitTook.Round(time.Millisecond))
}

// synthScan parses `total` synthetic records the way volume.scan does.
func synthScan(total int) *mftScan {
	s := newScan(int64(total))
	buf := make([]byte, 1024)
	words := []string{"report", "photo", "invoice", "setup", "config", "readme", "notes", "résumé", "data", "backup"}
	exts := []string{".txt", ".pdf", ".jpg", ".dll", ".exe", ".docx", ".png", ".json"}
	excludedDirs := []uint32{17} // WinSxS and folders below it
	keptDirs := []uint32{19}     // Users\bob and folders below it

	fill(buf, recordInUse|recordDirectory, 5, ".", 0, 0)
	s.parseRecord(buf, 5)
	for _, d := range []struct {
		rec, parent uint32
		name        string
	}{{16, 5, "Windows"}, {17, 16, "WinSxS"}, {18, 5, "Users"}, {19, 18, "bob"}} {
		fill(buf, recordInUse|recordDirectory, d.parent, d.name, 0, 0)
		s.parseRecord(buf, d.rec)
	}
	for i := 20; i < total; i++ {
		kind := i % 10
		if kind > 5 {
			continue // free record
		}
		dirs := &excludedDirs
		if kind == 5 {
			dirs = &keptDirs
		}
		name := words[i%len(words)] + "_" + strconv.Itoa(i) + exts[i%len(exts)]
		parent := (*dirs)[(i*7)%len(*dirs)]
		flags := uint16(recordInUse)
		if i%16 == 0 || i%16 == 5 {
			flags |= recordDirectory
			name = words[i%len(words)] + " folder " + strconv.Itoa(i)
		}
		fill(buf, flags, parent, name, uint64(i*37), 1_700_000_000+int64(i))
		s.parseRecord(buf, uint32(i))
		if flags&recordDirectory != 0 {
			*dirs = append(*dirs, uint32(i))
		}
	}
	return s
}

// fill writes one 1024-byte MFT record into buf, laid out like the test
// helper `record`, without allocating.
func fill(buf []byte, flags uint16, parent uint32, name string, size uint64, mtime int64) {
	clear(buf)
	le := binary.LittleEndian
	copy(buf, "FILE")
	le.PutUint16(buf[4:], 48)
	le.PutUint16(buf[6:], 3)
	le.PutUint16(buf[20:], 56)
	le.PutUint16(buf[22:], flags)
	off := 56

	// $STANDARD_INFORMATION: modified time.
	le.PutUint32(buf[off:], attrStandardInfo)
	le.PutUint32(buf[off+4:], 16+8+48)
	le.PutUint32(buf[off+16:], 48)
	le.PutUint16(buf[off+20:], 24)
	le.PutUint64(buf[off+24+8:], uint64(mtime+11_644_473_600)*10_000_000)
	off += 16 + 8 + 48

	// $FILE_NAME.
	units := 0
	at := off + 24 + 66
	for _, r := range name {
		if r >= 0x10000 {
			a, b := utf16.EncodeRune(r)
			le.PutUint16(buf[at:], uint16(a))
			le.PutUint16(buf[at+2:], uint16(b))
			at, units = at+4, units+2
		} else {
			le.PutUint16(buf[at:], uint16(r))
			at, units = at+2, units+1
		}
	}
	vlen := 66 + units*2
	alen := (24 + vlen + 7) &^ 7
	le.PutUint32(buf[off:], attrFileName)
	le.PutUint32(buf[off+4:], uint32(alen))
	le.PutUint32(buf[off+16:], uint32(vlen))
	le.PutUint16(buf[off+20:], 24)
	le.PutUint64(buf[off+24:], uint64(parent)|1<<48)
	buf[off+24+64] = byte(units)
	buf[off+24+65] = 1
	off += alen

	// Non-resident $DATA: file size.
	le.PutUint32(buf[off:], attrData)
	le.PutUint32(buf[off+4:], 64)
	buf[off+8] = 1
	le.PutUint64(buf[off+48:], size)
	off += 64

	le.PutUint32(buf[off:], attrEnd)
	le.PutUint32(buf[24:], uint32(off+8))
	le.PutUint16(buf[48:], 0x0042)
	for i := 1; i <= 2; i++ {
		pos := i*512 - 2
		copy(buf[48+i*2:], buf[pos:pos+2])
		le.PutUint16(buf[pos:], 0x0042)
	}
}

var procGetProcessMemoryInfo = windows.NewLazySystemDLL("psapi.dll").NewProc("GetProcessMemoryInfo")

// peakPrivateBytes is the most memory this process has committed so far.
func peakPrivateBytes() uint64 {
	var c struct {
		cb                                                uint32
		pageFaultCount                                    uint32
		peakWorkingSet, workingSet                        uintptr
		quotaPeakPaged, quotaPaged, quotaPeakNon, quotaNon uintptr
		pagefileUsage, peakPagefileUsage                  uintptr
	}
	c.cb = uint32(unsafe.Sizeof(c))
	h, _ := windows.GetCurrentProcess()
	procGetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&c)), uintptr(c.cb))
	return uint64(c.peakPagefileUsage)
}
