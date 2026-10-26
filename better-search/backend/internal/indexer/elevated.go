package indexer

// Indexing reads the drives' file tables, which needs administrator rights,
// so that part runs in its own program (better-search-indexer.exe) started
// with the UAC prompt; the search helper never needs admin rights itself.
//
// The elevated indexer opens no file but the drives. The index lives in the
// user's own folder, where anything running as the user could swap a file
// for a link to a system file, which an administrator's process would then
// overwrite or delete. So it sends every row over a named pipe to the search
// helper, which runs as the user and writes the database (and index.lock)
// itself. While it runs, the helper holds index.lock open with no sharing,
// so the watcher knows to wait.

import (
	"crypto/rand"
	"encoding/gob"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"better-search/backend/internal/database"

	"golang.org/x/sys/windows"
)

// ErrAdminDenied means the user said no (or closed) the UAC prompt.
var ErrAdminDenied = errors.New("administrator permission was declined")

// ErrBusy means another helper is indexing.
var ErrBusy = errors.New("indexing is already running")

var errStopped = errors.New("indexer stopped unexpectedly")

func lockPath(dbPath string) string { return filepath.Join(filepath.Dir(dbPath), "index.lock") }

// IsRunning reports whether a helper is indexing (holds the lock).
func IsRunning(dbPath string) bool {
	name, _ := windows.UTF16PtrFromString(lockPath(dbPath))
	h, err := windows.CreateFile(name, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, 0, 0)
	if err == nil {
		windows.CloseHandle(h)
		return false
	}
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION)
}

// fromIndexer is one message from the elevated indexer to the helper. The
// ones marked "answered" wait for a toIndexer.
type fromIndexer struct {
	Log         string
	Progress    *Progress
	VolumeIndex *uint64 // a volume's serial number: answered with its index
	Begin       bool    // start replacing the files table: answered
	Files       []database.File
	Commit      bool // finish replacing it: answered
	Done        bool // with Stats: the index is built
	Stats       []DriveStats
	Error       string // the index failed
}

// toIndexer is one message from the helper: first the options, then an
// answer to each question. JSON, not gob, as the elevated side reads it and
// gob isn't meant for input it can't trust.
type toIndexer struct {
	Options     *Options `json:"options,omitempty"`
	VolumeIndex int64    `json:"volume_index,omitempty"`
	Error       string   `json:"error,omitempty"`
}

// pipePrefix starts the name of every indexing pipe; the rest is random, so
// no other program can guess it and set up one first.
const pipePrefix = `\\.\pipe\better-search-index-`

// Only the user who started the helper, administrators (the elevated indexer,
// which may run as another account when an administrator answered the UAC
// prompt) and the system may open the pipe.
const pipeSDDL = "D:P(A;;GA;;;OW)(A;;GA;;;BA)(A;;GA;;;SY)"

// Session is one full index, from the UAC prompt until it's saved.
type Session struct {
	lock, pipe, proc windows.Handle
	name             string
}

// Start takes the lock, makes the pipe and starts the elevated indexer.
// Windows shows the UAC prompt (naming the indexer) and this blocks until
// the user answers it.
func Start(dbPath string) (*Session, error) {
	s := &Session{}
	var err error
	if s.lock, err = takeLock(dbPath); err != nil {
		return nil, err
	}
	if s.pipe, s.name, err = createPipe(); err != nil {
		s.close()
		return nil, err
	}
	if s.proc, err = launchElevated(s.name); err != nil {
		s.close()
		return nil, err
	}
	return s, nil
}

func (s *Session) close() {
	for _, h := range []windows.Handle{s.pipe, s.proc, s.lock} {
		if h != 0 {
			windows.CloseHandle(h)
		}
	}
	s.pipe, s.proc, s.lock = 0, 0, 0
}

// Serve sends the indexer the user's options and writes what it reads to
// db, calling onProgress for each progress report. Returns once the index is
// saved or has failed, and ends the session either way.
func (s *Session) Serve(db *database.DB, opts Options, onProgress func(Progress)) ([]DriveStats, error) {
	defer s.close()
	if err := s.connect(); err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(s.pipe), s.name)
	s.pipe = 0 // f closes it
	defer f.Close()
	return serve(db, f, opts, onProgress)
}

// connect waits for the indexer to open the pipe, and makes sure the program
// that did is the indexer this session started.
func (s *Session) connect() error {
	connected := make(chan error, 1)
	go func() {
		err := windows.ConnectNamedPipe(s.pipe, nil)
		if errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
			err = nil
		}
		connected <- err
	}()
	for {
		select {
		case err := <-connected:
			if err != nil {
				return fmt.Errorf("wait for the indexer: %w", err)
			}
			var pid uint32
			if err := windows.GetNamedPipeClientProcessId(s.pipe, &pid); err != nil {
				return fmt.Errorf("wait for the indexer: %w", err)
			}
			if want, _ := windows.GetProcessId(s.proc); pid != want {
				return errStopped
			}
			return nil
		case <-time.After(250 * time.Millisecond):
			if ev, _ := windows.WaitForSingleObject(s.proc, 0); ev == windows.WAIT_OBJECT_0 {
				// It exited without connecting. Connect from here to wake
				// ConnectNamedPipe; the process check above turns that away.
				if h, err := openPipe(s.name); err == nil {
					defer windows.CloseHandle(h)
				}
				<-connected
				return errStopped
			}
		}
	}
}

// serve is the helper's side of the pipe: it answers the indexer's questions
// and writes its rows, until the indexer says it's done or stops.
func serve(db *database.DB, f *os.File, opts Options, onProgress func(Progress)) ([]DriveStats, error) {
	dec := gob.NewDecoder(f)
	enc := json.NewEncoder(f)
	if err := enc.Encode(toIndexer{Options: &opts}); err != nil {
		return nil, errStopped
	}
	answer := func(index int64, err error) error {
		m := toIndexer{VolumeIndex: index}
		if err != nil {
			m.Error = err.Error()
		}
		return enc.Encode(m)
	}

	var bulk *database.Bulk
	defer func() {
		if bulk != nil {
			bulk.Abort()
		}
	}()
	for {
		var m fromIndexer
		if err := dec.Decode(&m); err != nil {
			return nil, errStopped
		}
		var err error
		switch {
		case m.Log != "":
			log.Printf("[indexer] %s", m.Log)
		case m.Progress != nil:
			onProgress(*m.Progress)
		case m.VolumeIndex != nil:
			err = answer(db.VolumeIndex(*m.VolumeIndex))
		case m.Begin:
			if bulk != nil {
				return nil, errors.New("indexer started twice")
			}
			var e error
			bulk, e = db.BeginBulk()
			if err = answer(0, e); e != nil {
				return nil, e // keeps the error's kind (a full disk) for the app
			}
		case len(m.Files) > 0:
			if bulk == nil {
				return nil, errors.New("indexer sent files before starting")
			}
			for _, file := range m.Files {
				if err = bulk.Add(file); err != nil {
					break
				}
			}
		case m.Commit:
			if bulk == nil {
				return nil, errors.New("indexer finished before starting")
			}
			e := bulk.Commit() // rolls back if it fails
			bulk = nil
			if err = answer(0, e); e != nil {
				return nil, e
			}
		case m.Done:
			return m.Stats, nil
		case m.Error != "":
			return nil, errors.New(m.Error)
		}
		// Returning closes the pipe, which stops the indexer.
		if err != nil {
			return nil, err
		}
	}
}

func takeLock(dbPath string) (windows.Handle, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return 0, err
	}
	name, _ := windows.UTF16PtrFromString(lockPath(dbPath))
	lock, err := windows.CreateFile(name, windows.GENERIC_WRITE, 0, nil, windows.CREATE_ALWAYS,
		windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_DELETE_ON_CLOSE, 0)
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		return 0, ErrBusy
	}
	return lock, err
}

func createPipe() (windows.Handle, string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0, "", err
	}
	name := pipePrefix + hex.EncodeToString(b[:])
	sd, err := windows.SecurityDescriptorFromString(pipeSDDL)
	if err != nil {
		return 0, "", err
	}
	sa := &windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	p, _ := windows.UTF16PtrFromString(name)
	h, err := windows.CreateNamedPipe(p,
		windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS,
		1, 1<<20, 1<<20, 0, sa)
	if err != nil {
		return 0, "", fmt.Errorf("create the indexer's pipe: %w", err)
	}
	return h, name, nil
}

// openPipe opens an indexing pipe as the client. Identification only: the
// helper at the other end can see who connected but can't act as them,
// which matters when the client is the elevated indexer.
func openPipe(name string) (windows.Handle, error) {
	if !strings.HasPrefix(name, pipePrefix) {
		return 0, errors.New("not an indexing pipe")
	}
	p, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING,
		windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IDENTIFICATION, 0)
	if err != nil {
		return 0, err
	}
	if t, _ := windows.GetFileType(h); t != windows.FILE_TYPE_PIPE {
		windows.CloseHandle(h)
		return 0, errors.New("not an indexing pipe")
	}
	return h, nil
}

// RunChild is the body of the elevated indexer program (cmd/indexer): it
// connects to the helper's pipe, indexes and exits. Returns the exit code.
func RunChild(pipeName string) int {
	h, err := openPipe(pipeName)
	if err != nil {
		return 2
	}
	f := os.NewFile(uintptr(h), pipeName)
	defer f.Close()
	c := &helperConn{enc: gob.NewEncoder(f), dec: json.NewDecoder(f)}
	log.SetFlags(0) // the helper adds its own timestamps
	log.SetOutput(logWriter{c})

	var hello toIndexer
	if err := c.dec.Decode(&hello); err != nil || hello.Options == nil {
		return 1
	}
	ix := New(c, DefaultExcludedDirs, DefaultExcludedPaths, func(p Progress) {
		c.send(fromIndexer{Progress: &p})
	})
	ix.Apply(*hello.Options)
	stats, err := ix.Run()
	if err != nil {
		c.send(fromIndexer{Error: err.Error()})
		return 1
	}
	if c.send(fromIndexer{Done: true, Stats: stats}) != nil {
		return 1
	}
	return 0
}

// filesPerMessage is how many rows the indexer sends the helper at once.
const filesPerMessage = 4096

// helperConn is the elevated indexer's end of the pipe. It's the indexer's
// Store and Bulk: the helper does the writing.
type helperConn struct {
	mu    sync.Mutex
	enc   *gob.Encoder
	dec   *json.Decoder
	files []database.File
}

func (c *helperConn) send(m fromIndexer) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.enc.Encode(m)
}

func (c *helperConn) ask(m fromIndexer) (toIndexer, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var r toIndexer
	if err := c.enc.Encode(m); err != nil {
		return r, err
	}
	if err := c.dec.Decode(&r); err != nil {
		return r, err
	}
	if r.Error != "" {
		return r, errors.New(r.Error)
	}
	return r, nil
}

func (c *helperConn) VolumeIndex(serial uint64) (int64, error) {
	r, err := c.ask(fromIndexer{VolumeIndex: &serial})
	return r.VolumeIndex, err
}

func (c *helperConn) BeginBulk() (Bulk, error) {
	_, err := c.ask(fromIndexer{Begin: true})
	return c, err
}

func (c *helperConn) Add(f database.File) error {
	c.files = append(c.files, f)
	if len(c.files) == filesPerMessage {
		return c.flush()
	}
	return nil
}

func (c *helperConn) flush() error {
	if len(c.files) == 0 {
		return nil
	}
	err := c.send(fromIndexer{Files: c.files})
	c.files = c.files[:0]
	return err
}

func (c *helperConn) Commit() error {
	if err := c.flush(); err != nil {
		return err
	}
	_, err := c.ask(fromIndexer{Commit: true})
	return err
}

// Abort drops unsent rows; the helper rolls back once the indexer reports
// the error or exits.
func (c *helperConn) Abort() { c.files = c.files[:0] }

// logWriter sends the indexer's log lines to the helper, whose log is the
// app's.
type logWriter struct{ c *helperConn }

func (w logWriter) Write(p []byte) (int, error) {
	if err := w.c.send(fromIndexer{Log: strings.TrimRight(string(p), "\n")}); err != nil {
		return 0, err
	}
	return len(p), nil
}

// shellExecuteInfo is SHELLEXECUTEINFOW.
type shellExecuteInfo struct {
	cbSize         uint32
	fMask          uint32
	hwnd           windows.Handle
	lpVerb         *uint16
	lpFile         *uint16
	lpParameters   *uint16
	lpDirectory    *uint16
	nShow          int32
	hInstApp       windows.Handle
	lpIDList       uintptr
	lpClass        *uint16
	hkeyClass      windows.Handle
	dwHotKey       uint32
	hIconOrMonitor windows.Handle
	hProcess       windows.Handle
}

const (
	seeMaskNoCloseProcess = 0x00000040
	seeMaskNoAsync        = 0x00000100
	swHide                = 0
)

var procShellExecuteEx = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW")

// IndexerExe is the indexer program, installed next to the search helper.
const IndexerExe = "better-search-indexer.exe"

// launchElevated starts the indexer as administrator, telling it the pipe to
// connect to. Returns the process handle.
func launchElevated(pipeName string) (windows.Handle, error) {
	self, err := os.Executable()
	if err != nil {
		return 0, err
	}
	exe := filepath.Join(filepath.Dir(self), IndexerExe)

	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	params, _ := windows.UTF16PtrFromString("-pipe " + pipeName) // no spaces to quote

	info := shellExecuteInfo{
		fMask:        seeMaskNoCloseProcess | seeMaskNoAsync,
		lpVerb:       verb,
		lpFile:       file,
		lpParameters: params,
		nShow:        swHide,
	}
	info.cbSize = uint32(unsafe.Sizeof(info))

	if ok, _, err := procShellExecuteEx.Call(uintptr(unsafe.Pointer(&info))); ok == 0 {
		if errors.Is(err, windows.ERROR_CANCELLED) {
			return 0, ErrAdminDenied
		}
		return 0, fmt.Errorf("start elevated indexer: %w", err)
	}
	if info.hProcess == 0 {
		return 0, errors.New("start elevated indexer: no process handle")
	}
	return info.hProcess, nil
}
