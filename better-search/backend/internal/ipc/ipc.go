// Package ipc is the JSON-lines protocol between Tauri and the backend:
// one request per line on stdin, one response or event per line on stdout.
package ipc

import (
	"encoding/json"
	"io"
	"sync"
)

// Request types.
const (
	TypeSearch  = "search"  // {query, limit}
	TypeOpen    = "open"    // {file_id}: user opened a result, bump its ranking
	TypeStatus  = "status"  // index state
	TypeReindex = "reindex" // rebuild the whole index; shows the UAC prompt
)

// Event types sent without a request.
const (
	EventIndexProgress = "index_progress"
	EventIndexDone     = "index_done"
	EventIndexError    = "index_error"
)

// Error codes.
const (
	CodeAdminDenied = "admin_denied" // user declined the UAC prompt
	CodeBusy        = "busy"         // indexing already running
)

type Request struct {
	ID     string `json:"id,omitempty"` // echoed back so the caller can match responses
	Type   string `json:"type"`         // empty means "search", for older callers
	Query  string `json:"query,omitempty"`
	Limit  int    `json:"limit,omitempty"`
	FileID int64  `json:"file_id,omitempty"`
}

type Status struct {
	Indexing  bool  `json:"indexing"`
	IndexedAt int64 `json:"indexed_at"` // unix seconds, 0 = never
	FileCount int64 `json:"file_count"`
}

type Response struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Status  string `json:"status"` // "ok" or "error"
	Results any    `json:"results,omitempty"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
	Code    string `json:"code,omitempty"` // machine-readable error, e.g. CodeAdminDenied
}

// Writer serialises responses so search replies and indexing events from
// different goroutines never interleave on stdout.
type Writer struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func NewWriter(w io.Writer) *Writer {
	return &Writer{enc: json.NewEncoder(w)}
}

func (w *Writer) Send(r Response) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.enc.Encode(r)
}

func (w *Writer) OK(id, typ string, results, data any) {
	w.Send(Response{ID: id, Type: typ, Status: "ok", Results: results, Data: data})
}

func (w *Writer) Error(id, typ, msg string) {
	w.Send(Response{ID: id, Type: typ, Status: "error", Error: msg})
}

func (w *Writer) ErrorCode(id, typ, code, msg string) {
	w.Send(Response{ID: id, Type: typ, Status: "error", Error: msg, Code: code})
}
