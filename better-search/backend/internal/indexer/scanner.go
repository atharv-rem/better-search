package indexer

// Reads every file entry straight from an NTFS volume's Master File Table
// ($MFT) instead of walking folders. Needs administrator rights.
//
// Layout references: https://flatcap.github.io/linux-ntfs/ntfs/

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"sort"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	fsctlGetNtfsVolumeData = 0x00090064

	rootRecord      = 5  // the volume's root folder
	firstUserRecord = 16 // records below this are NTFS metadata ($MFT, $LogFile, ...)

	attrStandardInfo  = 0x10
	attrAttributeList = 0x20
	attrFileName      = 0x30
	attrData          = 0x80
	attrEnd           = 0xFFFFFFFF

	recordInUse     = 0x01
	recordDirectory = 0x02

	namespaceDOS = 2 // 8.3 short names like PROGRA~1, skipped

	refMask = 0x0000FFFFFFFFFFFF // low 48 bits of a file reference = record number

	readChunk = 4 << 20 // bytes read from the MFT per call
)

var le = binary.LittleEndian

type volume struct {
	drive           string // "C:"
	file            *os.File
	serial          uint64
	bytesPerCluster int64
	recordSize      int64
	mftStartLcn     int64
	mftValidLength  int64
}

// run is one contiguous piece of the $MFT on disk. lcn < 0 marks a sparse run.
type run struct {
	lcn      int64
	clusters int64
}

// entry is what we keep per MFT record while scanning: millions of them, so
// it's kept small. Its name sits in mftScan.names rather than in a string of
// its own, which would add a 16-byte header and an allocation per record.
type entry struct {
	size    int64
	mtime   uint32 // unix seconds; 0 if unknown or before 1970 (see unixTime)
	parent  uint32
	name    uint32 // offset in mftScan.names
	nameLen uint16 // in bytes; 0 until the record's name is read
	flags   uint8
}

const (
	entryInUse uint8 = 1 << iota
	entryDir
)

// link is an extra name for a hard-linked file (same record, another folder).
type link struct {
	parent  uint32
	name    uint32 // offset in mftScan.names
	nameLen uint16
}

type mftScan struct {
	entries []entry
	links   map[uint32][]link
	names   []byte // every entry's and link's name, as UTF-8, back to back
}

// Bytes of names to expect per record, for sizing mftScan.names up front
// rather than growing it (each growth briefly holds the old copy too).
const nameBytesPerRecord = 12

func newScan(records int64) *mftScan {
	return &mftScan{
		entries: make([]entry, records),
		links:   make(map[uint32][]link),
		names:   make([]byte, 0, records*nameBytesPerRecord),
	}
}

// name is a name stored in s.names, as a string viewing those bytes rather
// than a copy. They never change once the scan has finished.
func (s *mftScan) name(off uint32, n uint16) string {
	if n == 0 {
		return ""
	}
	return unsafe.String(&s.names[off], int(n))
}

// appendName decodes a UTF-16LE name from a record onto s.names, with no
// copies along the way, and returns where it went. Unpaired surrogates
// become U+FFFD, as utf16.Decode makes them.
func (s *mftScan) appendName(b []byte) (uint32, uint16) {
	off := len(s.names)
	for i := 0; i+1 < len(b); i += 2 {
		u := rune(le.Uint16(b[i:]))
		switch {
		case u < utf8.RuneSelf:
			s.names = append(s.names, byte(u))
		case utf16.IsSurrogate(u) && i+3 < len(b):
			if r := utf16.DecodeRune(u, rune(le.Uint16(b[i+2:]))); r != utf8.RuneError {
				s.names = utf8.AppendRune(s.names, r)
				i += 2
			} else {
				s.names = utf8.AppendRune(s.names, utf8.RuneError)
			}
		default:
			s.names = utf8.AppendRune(s.names, u) // a lone surrogate encodes as U+FFFD
		}
	}
	return uint32(off), uint16(len(s.names) - off)
}

func openVolume(drive string) (*volume, error) {
	path, err := windows.UTF16PtrFromString(`\\.\` + drive)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(path, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return nil, fmt.Errorf("open volume %s: %w", drive, err)
	}

	var buf [512]byte
	var n uint32
	if err := windows.DeviceIoControl(h, fsctlGetNtfsVolumeData, nil, 0, &buf[0], uint32(len(buf)), &n, nil); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("%s is not an NTFS volume: %w", drive, err)
	}

	v := &volume{
		drive:           drive,
		file:            os.NewFile(uintptr(h), drive),
		serial:          le.Uint64(buf[0:]),
		bytesPerCluster: int64(le.Uint32(buf[44:])),
		recordSize:      int64(le.Uint32(buf[48:])),
		mftValidLength:  int64(le.Uint64(buf[56:])),
		mftStartLcn:     int64(le.Uint64(buf[64:])),
	}
	if v.bytesPerCluster <= 0 || v.recordSize <= 0 || readChunk%v.bytesPerCluster != 0 {
		v.file.Close()
		return nil, fmt.Errorf("%s: unexpected NTFS geometry (cluster %d, record %d)", drive, v.bytesPerCluster, v.recordSize)
	}
	return v, nil
}

func (v *volume) Close() error {
	return v.file.Close()
}

func (v *volume) recordCount() int64 {
	return v.mftValidLength / v.recordSize
}

// readRecordAt reads one MFT record at a byte offset on the volume. Volume
// reads must be sector-aligned, so it reads whole clusters around it.
func (v *volume) readRecordAt(offset int64) ([]byte, error) {
	start := offset - offset%v.bytesPerCluster
	length := offset - start + v.recordSize
	length = (length + v.bytesPerCluster - 1) / v.bytesPerCluster * v.bytesPerCluster

	buf := make([]byte, length)
	if _, err := v.file.ReadAt(buf, start); err != nil {
		return nil, err
	}
	rec := buf[offset-start : offset-start+v.recordSize]
	if string(rec[:4]) != "FILE" || !applyFixup(rec) {
		return nil, errors.New("corrupt MFT record")
	}
	return rec, nil
}

// mftRuns finds where the $MFT itself lives on disk, from record 0's $DATA.
// A very fragmented $MFT spreads that $DATA over extra records listed in an
// attribute list; those are followed too.
func (v *volume) mftRuns() ([]run, error) {
	rec0, err := v.readRecordAt(v.mftStartLcn * v.bytesPerCluster)
	if err != nil {
		return nil, fmt.Errorf("%s: read $MFT record: %w", v.drive, err)
	}

	type fragment struct {
		startVcn int64
		runs     []run
	}
	var frags []fragment
	var extraRecords []int64

	collect := func(rec []byte, isBase bool) error {
		return eachAttribute(rec, func(typ uint32, a []byte) error {
			switch {
			case typ == attrData && a[8] != 0 && a[9] == 0:
				runOff := int(le.Uint16(a[32:]))
				if runOff >= len(a) {
					return errors.New("corrupt $MFT data attribute")
				}
				runs, err := parseRuns(a[runOff:])
				if err != nil {
					return err
				}
				frags = append(frags, fragment{int64(le.Uint64(a[16:])), runs})
			case typ == attrAttributeList && isBase:
				if a[8] != 0 {
					return errors.New("non-resident $MFT attribute list is not supported")
				}
				list := residentValue(a)
				for off := 0; off+26 <= len(list); {
					elen := int(le.Uint16(list[off+4:]))
					if elen == 0 {
						break
					}
					ref := int64(le.Uint64(list[off+16:]) & refMask)
					if le.Uint32(list[off:]) == attrData && list[off+6] == 0 && ref != 0 {
						extraRecords = append(extraRecords, ref)
					}
					off += elen
				}
			}
			return nil
		})
	}

	if err := collect(rec0, true); err != nil {
		return nil, fmt.Errorf("%s: %w", v.drive, err)
	}

	join := func() []run {
		sort.Slice(frags, func(i, j int) bool { return frags[i].startVcn < frags[j].startVcn })
		var all []run
		for _, f := range frags {
			all = append(all, f.runs...)
		}
		return all
	}

	seen := map[int64]bool{}
	for _, recNo := range extraRecords {
		if seen[recNo] {
			continue
		}
		seen[recNo] = true
		off, ok := recordOffset(join(), recNo, v.recordSize, v.bytesPerCluster)
		if !ok {
			return nil, fmt.Errorf("%s: $MFT extension record %d not reachable", v.drive, recNo)
		}
		rec, err := v.readRecordAt(off)
		if err != nil {
			return nil, fmt.Errorf("%s: read $MFT extension record: %w", v.drive, err)
		}
		if err := collect(rec, false); err != nil {
			return nil, fmt.Errorf("%s: %w", v.drive, err)
		}
	}

	runs := join()
	if len(runs) == 0 {
		return nil, fmt.Errorf("%s: $MFT has no data runs", v.drive)
	}
	return runs, nil
}

func recordOffset(runs []run, recNo, recordSize, bytesPerCluster int64) (int64, bool) {
	byteOff := recNo * recordSize
	vcn := byteOff / bytesPerCluster
	var at int64
	for _, r := range runs {
		if vcn < at+r.clusters {
			if r.lcn < 0 {
				return 0, false
			}
			return (r.lcn+vcn-at)*bytesPerCluster + byteOff%bytesPerCluster, true
		}
		at += r.clusters
	}
	return 0, false
}

// scan reads the whole $MFT in large sequential chunks and parses every record.
// progress is called with (records read, total records).
func (v *volume) scan(progress func(done, total int64)) (*mftScan, error) {
	runs, err := v.mftRuns()
	if err != nil {
		return nil, err
	}

	total := v.recordCount()
	s := newScan(total)

	buf := make([]byte, readChunk)
	var carry []byte // a record split across two runs
	var recNo int64
	lastReport := int64(0)

	for _, r := range runs {
		if recNo >= total {
			break
		}
		runBytes := r.clusters * v.bytesPerCluster
		if r.lcn < 0 {
			recNo += runBytes / v.recordSize
			carry = nil
			continue
		}
		for off := int64(0); off < runBytes && recNo < total; {
			n := min(runBytes-off, int64(len(buf)))
			if _, err := v.file.ReadAt(buf[:n], r.lcn*v.bytesPerCluster+off); err != nil {
				return nil, fmt.Errorf("%s: read $MFT: %w", v.drive, err)
			}
			off += n

			data := buf[:n]
			if len(carry) > 0 {
				data = append(carry, data...)
				carry = nil
			}
			i := int64(0)
			for ; i+v.recordSize <= int64(len(data)) && recNo < total; i += v.recordSize {
				s.parseRecord(data[i:i+v.recordSize], uint32(recNo))
				recNo++
			}
			if rest := data[i:]; len(rest) > 0 && recNo < total {
				carry = append([]byte(nil), rest...)
			}

			if progress != nil && recNo-lastReport >= 100_000 {
				progress(recNo, total)
				lastReport = recNo
			}
		}
	}
	if progress != nil {
		progress(recNo, total)
	}
	return s, nil
}

// parseRecord merges one MFT record into the entry it belongs to. Large files
// spill attributes into extension records that point back at a base record,
// so extension records are merged into their base entry.
func (s *mftScan) parseRecord(rec []byte, recNo uint32) {
	if string(rec[:4]) != "FILE" || !applyFixup(rec) {
		return
	}
	flags := le.Uint16(rec[22:])
	if flags&recordInUse == 0 {
		return
	}

	target := recNo
	base := le.Uint64(rec[32:]) & refMask
	if base != 0 {
		if base >= uint64(len(s.entries)) {
			return
		}
		target = uint32(base)
	}
	e := &s.entries[target]
	if base == 0 {
		e.flags |= entryInUse
		if flags&recordDirectory != 0 {
			e.flags |= entryDir
		}
	}

	eachAttribute(rec, func(typ uint32, a []byte) error {
		nonResident := a[8] != 0
		switch typ {
		case attrStandardInfo:
			if v := residentValue(a); !nonResident && len(v) >= 16 {
				e.mtime = unixTime(filetimeToUnix(le.Uint64(v[8:])))
			}

		case attrFileName:
			v := residentValue(a)
			if nonResident || len(v) < 66 || v[65] == namespaceDOS {
				return nil
			}
			nameLen := int(v[64])
			if 66+nameLen*2 > len(v) {
				return nil
			}
			parent := uint32(le.Uint64(v[0:]) & refMask)
			off, n := s.appendName(v[66 : 66+nameLen*2])
			switch {
			case e.nameLen == 0:
				e.name, e.nameLen, e.parent = off, n, parent
			case parent != e.parent || s.name(off, n) != s.name(e.name, e.nameLen):
				s.links[target] = append(s.links[target], link{parent, off, n})
			default:
				s.names = s.names[:off] // the name it already has: drop the copy
			}

		case attrData:
			if a[9] != 0 { // named stream (e.g. Zone.Identifier), not the file contents
				return nil
			}
			if nonResident {
				if len(a) >= 56 && le.Uint64(a[16:]) == 0 {
					e.size = int64(le.Uint64(a[48:]))
				}
			} else {
				e.size = int64(le.Uint32(a[16:]))
			}
		}
		return nil
	})
}

// eachAttribute calls fn for every attribute in a record, with bounds checked
// so a damaged record can't crash the scan.
func eachAttribute(rec []byte, fn func(typ uint32, attr []byte) error) error {
	off := int(le.Uint16(rec[20:]))
	used := int(le.Uint32(rec[24:]))
	if used > len(rec) {
		used = len(rec)
	}
	for off+16 <= used {
		typ := le.Uint32(rec[off:])
		if typ == attrEnd {
			return nil
		}
		alen := int(le.Uint32(rec[off+4:]))
		if alen < 16 || off+alen > used {
			return nil
		}
		a := rec[off : off+alen]
		if a[8] != 0 && alen < 64 { // non-resident header is 64 bytes
			return nil
		}
		if err := fn(typ, a); err != nil {
			return err
		}
		off += alen
	}
	return nil
}

func residentValue(a []byte) []byte {
	if len(a) < 24 {
		return nil
	}
	vlen := int(le.Uint32(a[16:]))
	voff := int(le.Uint16(a[20:]))
	if voff+vlen > len(a) {
		return nil
	}
	return a[voff : voff+vlen]
}

// applyFixup undoes NTFS's torn-write protection: the last 2 bytes of each
// sector were swapped for a check value, and the real bytes are stored in the
// record header. Returns false if a sector didn't match (record is damaged).
func applyFixup(rec []byte) bool {
	usaOff := int(le.Uint16(rec[4:]))
	usaCount := int(le.Uint16(rec[6:]))
	if usaCount < 2 || usaOff+usaCount*2 > len(rec) {
		return false
	}
	stride := len(rec) / (usaCount - 1)
	check := le.Uint16(rec[usaOff:])
	for i := 1; i < usaCount; i++ {
		pos := i*stride - 2
		if le.Uint16(rec[pos:]) != check {
			return false
		}
		copy(rec[pos:pos+2], rec[usaOff+i*2:usaOff+i*2+2])
	}
	return true
}

// parseRuns decodes an NTFS data run list into absolute cluster runs.
func parseRuns(b []byte) ([]run, error) {
	var runs []run
	var lcn int64
	for i := 0; i < len(b) && b[i] != 0; {
		lenSize, offSize := int(b[i]&0x0F), int(b[i]>>4)
		i++
		if lenSize == 0 || lenSize > 8 || offSize > 8 || i+lenSize+offSize > len(b) {
			return nil, errors.New("corrupt data run list")
		}
		length := int64(readLE(b[i : i+lenSize]))
		i += lenSize
		if offSize == 0 {
			runs = append(runs, run{lcn: -1, clusters: length})
			continue
		}
		shift := 64 - 8*offSize // sign-extend the relative offset
		delta := int64(readLE(b[i:i+offSize])<<shift) >> shift
		i += offSize
		lcn += delta
		runs = append(runs, run{lcn: lcn, clusters: length})
	}
	return runs, nil
}

func readLE(b []byte) uint64 {
	var v uint64
	for k := len(b) - 1; k >= 0; k-- {
		v = v<<8 | uint64(b[k])
	}
	return v
}

// unixTime fits unix seconds in an entry: times before 1970 (corrupt, in
// practice) become 0, unknown, and the latest it holds is in 2106.
func unixTime(sec int64) uint32 {
	return uint32(min(max(sec, 0), 1<<32-1))
}

// filetimeToUnix converts Windows FILETIME (100ns ticks since 1601) to unix seconds.
func filetimeToUnix(ft uint64) int64 {
	if ft == 0 {
		return 0
	}
	return int64(ft/10_000_000) - 11_644_473_600
}
