package winsearch

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

// Windows Search's OLE DB provider, read through ADO: the documented way to
// query the index from a desktop app.
const connectionString = "Provider=Search.CollatorDSO;Extended Properties='Application=Windows';"

// ErrUnavailable means Windows Search can't be reached: its service is off
// or disabled.
var ErrUnavailable = errors.New("windows search is not available")

const (
	adOpenForwardOnly = 0
	adLockReadOnly    = 1
	adClipString      = 2
	// Seconds before ADO gives up on a query.
	commandTimeout = 10
)

// Searcher runs queries on one thread of its own, as COM objects belong to
// the thread that made them. The thread starts with the first query; the
// connection is opened then and kept for the next ones, until Release.
type Searcher struct {
	once sync.Once
	jobs chan job
}

type job struct {
	ctx     context.Context
	sql     string
	top     int
	release bool // close the connection instead
	reply   chan reply
}

type reply struct {
	paths []string
	err   error
}

func New() *Searcher {
	return &Searcher{jobs: make(chan job, 8)}
}

// Search returns the paths of up to top files containing every word of
// query, best match first. Cancelling ctx returns at once with its error;
// a query already sent to Windows runs to the end, and its answer is dropped.
func (s *Searcher) Search(ctx context.Context, query string, top int) ([]string, error) {
	sql, ok := buildSQL(query, top)
	if !ok {
		return nil, nil
	}
	s.once.Do(func() { go s.run() })
	j := job{ctx: ctx, sql: sql, top: top, reply: make(chan reply, 1)}
	select {
	case s.jobs <- j:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case r := <-j.reply:
		return r.paths, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Release closes the connection and unloads Windows Search's DLLs from this
// process, if a query isn't waiting. The next query loads them again.
func (s *Searcher) Release() {
	select {
	case s.jobs <- job{release: true}:
	default:
	}
}

func (s *Searcher) run() {
	runtime.LockOSThread()
	var conn *ole.IDispatch
	comUp := false
	// Ends COM on this thread, the only one using it: Windows then unloads
	// ADO and the search provider, and what they hold goes with them.
	shutdown := func() {
		if conn != nil {
			oleutil.CallMethod(conn, "Close")
			conn.Release()
			conn = nil
		}
		if comUp {
			ole.CoUninitialize()
			comUp = false
		}
	}
	for j := range s.jobs {
		if j.release {
			shutdown()
			continue
		}
		// Typing on has superseded it while it waited.
		if err := j.ctx.Err(); err != nil {
			j.reply <- reply{err: err}
			continue
		}
		if !comUp {
			// Multithreaded, so the calls need no message loop on this thread.
			if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
				j.reply <- reply{err: fmt.Errorf("%w: %v", ErrUnavailable, err)}
				continue
			}
			comUp = true
		}
		if conn == nil {
			c, err := open()
			if err != nil {
				j.reply <- reply{err: err}
				continue
			}
			conn = c
		}
		paths, err := query(conn, j.sql, j.top)
		if err != nil {
			// Windows Search may have restarted: a new connection next time.
			shutdown()
		}
		j.reply <- reply{paths: paths, err: err}
	}
}

func open() (*ole.IDispatch, error) {
	unknown, err := oleutil.CreateObject("ADODB.Connection")
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	conn, err := unknown.QueryInterface(ole.IID_IDispatch)
	unknown.Release()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if _, err := oleutil.PutProperty(conn, "CommandTimeout", commandTimeout); err != nil {
		conn.Release()
		return nil, err
	}
	if _, err := oleutil.CallMethod(conn, "Open", connectionString); err != nil {
		conn.Release()
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return conn, nil
}

// query runs sql and reads every row in one call (GetString), rather than
// several calls for each field of each row.
func query(conn *ole.IDispatch, sql string, top int) ([]string, error) {
	unknown, err := oleutil.CreateObject("ADODB.Recordset")
	if err != nil {
		return nil, err
	}
	rs, err := unknown.QueryInterface(ole.IID_IDispatch)
	unknown.Release()
	if err != nil {
		return nil, err
	}
	defer rs.Release()
	if _, err := oleutil.CallMethod(rs, "Open", sql, conn, adOpenForwardOnly, adLockReadOnly); err != nil {
		return nil, fmt.Errorf("windows search query: %w", err)
	}
	defer oleutil.CallMethod(rs, "Close")

	eof, err := oleutil.GetProperty(rs, "EOF")
	if err != nil {
		return nil, err
	}
	atEnd, _ := eof.Value().(bool)
	eof.Clear()
	if atEnd {
		return nil, nil
	}
	rows, err := oleutil.CallMethod(rs, "GetString", adClipString, top, "\t", "\n", "")
	if err != nil {
		return nil, err
	}
	defer rows.Clear()
	return splitRows(rows.ToString()), nil
}
