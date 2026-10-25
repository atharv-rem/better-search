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
	"sync/atomic"
	"syscall"

	"better-search/backend/internal/database"
	"better-search/backend/internal/indexer"
	"better-search/backend/internal/ipc"
	"better-search/backend/internal/memory"
	"better-search/backend/internal/search"
)

// The search helper (better-search-helper.exe): answers the app's searches
// over stdin/stdout and starts full indexes. The file watcher and the indexer
// are separate programs built from cmd/watcher and cmd/indexer, so each
// shows under its own name in Task Manager.
func main() {
	dbPath := flag.String("db", database.DefaultPath(), "path to the SQLite index")
	settingsPath := flag.String("settings", "", "the app's settings.json, for the user's indexing exclusions")
	flag.Parse()

	// Runs for as long as the app, idle most of the time: collect garbage
	// sooner, so the heap stays small between searches.
	debug.SetGCPercent(50)

	log.Println("🚀 Better Search backend started successfully!")

	db, err := database.Open(*dbPath)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
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
		case ipc.TypeSearch:
			results, err := search.Search(db, req.Query, req.Limit)
			if err != nil {
				out.Error(req.ID, req.Type, err.Error())
				continue
			}
			out.OK(req.ID, req.Type, results, nil)

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
				log.Printf("Failed to read the page cache size: %v", err)
			}
			out.OK(req.ID, req.Type, nil, ipc.Status{
				Indexing:   indexing.Load(),
				IndexedAt:  indexedAt,
				FileCount:  count,
				CacheBytes: cacheUsed,
				CacheLimit: database.CacheLimit,
			})

		case ipc.TypeTrim:
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
				session, err := indexer.Start(*dbPath)
				if err != nil {
					code := ""
					switch {
					case errors.Is(err, indexer.ErrAdminDenied):
						code = ipc.CodeAdminDenied
					case errors.Is(err, indexer.ErrBusy):
						code = ipc.CodeBusy
					}
					out.ErrorCode(id, ipc.TypeReindex, code, err.Error())
					return
				}
				out.OK(id, ipc.TypeReindex, nil, nil)
				stats, err := session.Serve(db, indexer.LoadOptions(*settingsPath), func(p indexer.Progress) {
					out.OK("", ipc.EventIndexProgress, nil, p)
				})
				if err != nil {
					log.Printf("Indexing failed: %v", err)
					out.Error("", ipc.EventIndexError, err.Error())
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
