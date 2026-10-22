package indexer

// Indexing runs in its own elevated copy of the backend ("-index-only"):
//   - only that process needs admin rights, so the search sidecar never does;
//   - it keeps running when Tauri stops the sidecar (window hidden), and the
//     next sidecar picks its progress back up from the report file.
//
// The child holds index.lock open with no sharing while it runs, and writes
// its progress to index-progress.json next to the database.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"better-search/backend/internal/database"

	"golang.org/x/sys/windows"
)

// ErrAdminDenied means the user said no (or closed) the UAC prompt.
var ErrAdminDenied = errors.New("administrator permission was declined")

// Report is what the indexing process publishes about itself.
type Report struct {
	State    string       `json:"state"` // "running", "done" or "error"
	Progress *Progress    `json:"progress,omitempty"`
	Stats    []DriveStats `json:"stats,omitempty"`
	Error    string       `json:"error,omitempty"`
}

func reportPath(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "index-progress.json")
}
func lockPath(dbPath string) string { return filepath.Join(filepath.Dir(dbPath), "index.lock") }

// RunChild is the body of the elevated "-index-only" process. Returns the exit code.
func RunChild(dbPath string) int {
	lockName, _ := windows.UTF16PtrFromString(lockPath(dbPath))
	lock, err := windows.CreateFile(lockName, windows.GENERIC_WRITE, 0, nil, windows.CREATE_ALWAYS,
		windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_DELETE_ON_CLOSE, 0)
	if err != nil {
		log.Printf("Another indexer is already running: %v", err)
		return 2
	}
	defer windows.CloseHandle(lock)

	report := func(r Report) {
		if err := writeReport(dbPath, r); err != nil {
			log.Printf("Failed to write progress: %v", err)
		}
	}
	report(Report{State: "running"})

	db, err := database.Open(dbPath)
	if err != nil {
		report(Report{State: "error", Error: err.Error()})
		return 1
	}
	defer db.Close()

	ix := New(db, DefaultExcludedDirs, DefaultExcludedPaths, func(p Progress) {
		report(Report{State: "running", Progress: &p})
	})
	stats, err := ix.Run()
	if err != nil {
		report(Report{State: "error", Error: err.Error()})
		return 1
	}
	report(Report{State: "done", Stats: stats})
	return 0
}

func writeReport(dbPath string, r Report) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	tmp := reportPath(dbPath) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, reportPath(dbPath))
}

func readReport(dbPath string) (Report, bool) {
	var r Report
	data, err := os.ReadFile(reportPath(dbPath))
	if err != nil || json.Unmarshal(data, &r) != nil {
		return r, false
	}
	return r, true
}

// IsRunning reports whether an indexing process currently holds the lock.
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

// LaunchElevated starts "-index-only" as administrator. Windows shows the UAC
// prompt and this blocks until the user answers it. Returns the process handle.
func LaunchElevated(dbPath string) (windows.Handle, error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	// A leftover "done" report from the last run must not be mistaken for this one.
	os.Remove(reportPath(dbPath))

	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	params, _ := windows.UTF16PtrFromString(syscall.EscapeArg("-index-only") + " -db " + syscall.EscapeArg(dbPath))

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

// Watch follows an indexing process until it ends, calling onProgress for
// each new progress report, and returns its final report. Pass the handle
// from LaunchElevated, or 0 to follow one a previous sidecar started.
func Watch(dbPath string, proc windows.Handle, onProgress func(Progress)) Report {
	if proc != 0 {
		defer windows.CloseHandle(proc)
	}

	var last Progress
	poll := func() {
		if r, ok := readReport(dbPath); ok && r.State == "running" && r.Progress != nil && *r.Progress != last {
			last = *r.Progress
			onProgress(last)
		}
	}

	for {
		if proc != 0 {
			if ev, _ := windows.WaitForSingleObject(proc, 250); ev == windows.WAIT_OBJECT_0 {
				break
			}
		} else {
			if !IsRunning(dbPath) {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		poll()
	}

	if r, ok := readReport(dbPath); ok && r.State != "running" {
		return r
	}
	return Report{State: "error", Error: "indexer stopped unexpectedly"}
}
