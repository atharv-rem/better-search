// Package memory gives an idle process's memory back to Windows.
package memory

import (
	"runtime/debug"

	"golang.org/x/sys/windows"
)

var procEmptyWorkingSet = windows.NewLazySystemDLL("kernel32.dll").NewProc("K32EmptyWorkingSet")

// Trim hands the heap back to Windows and drops the pages the process won't
// need until it next has work, so it sits at a few MB while idle. Touching
// them again only costs a soft page fault while Windows still has them.
func Trim() {
	debug.FreeOSMemory()
	if h, err := windows.GetCurrentProcess(); err == nil {
		procEmptyWorkingSet.Call(uintptr(h))
	}
}
