package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"better-search/backend/internal/database"
	"better-search/backend/internal/indexer"
	"better-search/backend/internal/ipc"
	"better-search/backend/internal/memory"
	"better-search/backend/internal/search"
	"better-search/backend/internal/winsearch"
)

// The search helper (better-search-helper.exe): answers the app's searches
// over stdin/stdout and starts full indexes. The file watcher and the indexer
// are separate programs built from cmd/watcher and cmd/indexer, so each
// shows under its own name in Task Manager.
func main() {
	dbPath := flag.String("db", database.DefaultPath(), "path to the SQLite index")
	settingsPath := flag.String("settings", "", "the app's settings.json, for the user's indexing exclusions")
	flag.Parse()
	// The app timestamps each line, and reads a leading "ERROR: " or "WARN: "
	// as its level.
	log.SetFlags(0)

	// Runs for as long as the app, idle most of the time: collect garbage
	// sooner, so the heap stays small between searches.
	debug.SetGCPercent(50)

	log.Println("🚀 Better Search backend started successfully!")

	db, err := database.Open(*dbPath)
	if err != nil {
		log.Fatalf("ERROR: Failed to open database: %v", err)
	}
	defer db.Close()
	log.Printf("Using index at %s", *dbPath)

	out := ipc.NewWriter(os.Stdout)

	// Handle graceful shutdown signals (Ctrl+C / SIGTERM)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		log.Println("👋 Shutting down backend cleanly...")
		db.Close()
		os.Exit(0)
	}()

	var indexing atomic.Bool
	excluded := &exclusions{settingsPath: *settingsPath}

	// Typing sends a search per pause, and only the newest one's results are
	// shown: each new search cancels the one before, which stops mid-query
	// rather than queueing the new one behind it. Called from the request loop
	// only, so cancelSearch needs no lock.
	// A content search replaces a name search too: the box shows one or the
	// other.
	cancelSearch := context.CancelFunc(func() {})
	contents := winsearch.New()
	startSearch := func(req ipc.Request) {
		cancelSearch()
		ctx, cancel := context.WithCancel(context.Background())
		cancelSearch = cancel
		go func() {
			defer cancel()
			var results []search.Result
			var err error
			if req.Type == ipc.TypeContent {
				results, err = search.Content(ctx, db, contents, req.Query, req.Limit, excluded.skip)
			} else {
				results, err = search.Search(ctx, db, req.Query, req.Limit, excluded.skip)
			}
			switch {
			case ctx.Err() != nil:
				out.ErrorCode(req.ID, req.Type, ipc.CodeSuperseded, "a newer search replaced this one")
			case errors.Is(err, winsearch.ErrUnavailable):
				out.ErrorCode(req.ID, req.Type, ipc.CodeNoWinSearch, err.Error())
			case err != nil:
				out.Error(req.ID, req.Type, err.Error())
			default:
				out.OK(req.ID, req.Type, results, nil)
			}
		}()
	}

	log.Println("Waiting for queries on Stdin...")

	// Read input from Stdin (sent by Tauri IPC)
	scanner := bufio.NewScanner(os.Stdin)

	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}

		var req ipc.Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			out.Error("", "", fmt.Sprintf("Failed to parse request: %v", err))
			continue
		}
		if req.Type == "" {
			req.Type = ipc.TypeSearch
		}

		switch req.Type {
		case ipc.TypeSearch, ipc.TypeContent:
			startSearch(req)

		case ipc.TypeOpen:
			// The indexer holds the write lock and replaces usage stats with its
			// start-of-scan snapshot anyway, so this open can't be recorded.
			if indexing.Load() {
				out.OK(req.ID, req.Type, nil, nil)
				continue
			}
			if err := db.MarkOpened(req.FileID); err != nil {
				out.Error(req.ID, req.Type, err.Error())
				continue
			}
			out.OK(req.ID, req.Type, nil, nil)

		case ipc.TypeStatus:
			indexedAt, _ := db.IndexedAt()
			count, _ := db.FileCount()
			cacheUsed, err := db.CacheUsed(context.Background())
			if err != nil {
				log.Printf("WARN: Failed to read the page cache size: %v", err)
			}
			out.OK(req.ID, req.Type, nil, ipc.Status{
				Indexing:   indexing.Load(),
				IndexedAt:  indexedAt,
				FileCount:  count,
				CacheBytes: cacheUsed,
				CacheLimit: database.CacheLimit,
			})

		case ipc.TypeTrim:
			contents.Release()
			db.Trim()
			memory.Trim()

		case ipc.TypeReindex:
			if !indexing.CompareAndSwap(false, true) {
				out.ErrorCode(req.ID, req.Type, ipc.CodeBusy, "indexing is already running")
				continue
			}
			// Start blocks until the user answers the UAC prompt, so keep
			// reading requests meanwhile.
			go func(id string) {
				defer indexing.Store(false)
				// Before the UAC prompt: a full disk would only fail minutes in.
				err := indexer.CheckSpace(*dbPath)
				var session *indexer.Session
				if err == nil {
					session, err = indexer.Start(*dbPath)
				}
				if err != nil {
					code := ""
					switch {
					case errors.Is(err, indexer.ErrAdminDenied):
						code = ipc.CodeAdminDenied
					case errors.Is(err, indexer.ErrBusy):
						code = ipc.CodeBusy
					case errors.Is(err, indexer.ErrDiskFull):
						code = ipc.CodeDiskFull
					}
					out.ErrorCode(id, ipc.TypeReindex, code, err.Error())
					return
				}
				out.OK(id, ipc.TypeReindex, nil, nil)
				stats, err := session.Serve(db, indexer.LoadOptions(*settingsPath), func(p indexer.Progress) {
					out.OK("", ipc.EventIndexProgress, nil, p)
				})
				if err != nil {
					log.Printf("ERROR: Indexing failed: %v", err)
					code := ""
					if database.IsDiskFull(err) {
						code = ipc.CodeDiskFull
					}
					out.ErrorCode("", ipc.EventIndexError, code, err.Error())
					return
				}
				// Closes the connection that wrote the index, and its big cache.
				db.Trim()
				memory.Trim()
				out.OK("", ipc.EventIndexDone, nil, stats)
			}(req.ID)

		default:
			out.Error(req.ID, req.Type, "unknown request type")
		}
	}

	if err := scanner.Err(); err != nil {
		log.Printf("Error reading stdin: %v\n", err)
	}

	log.Println("👋 Stdin closed. Shutting down backend...")
}

// exclusions leaves out of the results what the user's settings exclude now:
// a folder added in Settings stays in the index until a rebuild, which asks
// for administrator permission, so it's left out here meanwhile. The settings
// are read again whenever the file changes.
type exclusions struct {
	settingsPath string

	mu       sync.Mutex
	modified time.Time
	ix       *indexer.Indexer
}

func (e *exclusions) skip(path string, isDir bool) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.settingsPath != "" {
		if info, err := os.Stat(e.settingsPath); err == nil && !info.ModTime().Equal(e.modified) {
			e.modified = info.ModTime()
			e.ix = nil
		}
	}
	if e.ix == nil {
		e.ix = indexer.New(nil, indexer.DefaultExcludedDirs, indexer.DefaultExcludedPaths, nil)
		e.ix.Apply(indexer.LoadOptions(e.settingsPath))
	}
	return e.ix.Excluded(path, isDir)
}
