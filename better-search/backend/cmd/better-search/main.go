package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"

	"better-search/backend/internal/database"
	"better-search/backend/internal/indexer"
	"better-search/backend/internal/ipc"
	"better-search/backend/internal/search"

	"golang.org/x/sys/windows"
)

func main() {
	dbPath := flag.String("db", database.DefaultPath(), "path to the SQLite index")
	settingsPath := flag.String("settings", "", "the app's settings.json, for the user's indexing exclusions")
	indexOnly := flag.Bool("index-only", false, "build the index and exit (run elevated)")
	flag.Parse()

	if *indexOnly {
		os.Exit(indexer.RunChild(*dbPath, *settingsPath))
	}

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

	// follow reports an indexing process's progress until it finishes.
	follow := func(proc windows.Handle) {
		defer indexing.Store(false)
		r := indexer.Watch(*dbPath, proc, func(p indexer.Progress) {
			out.OK("", ipc.EventIndexProgress, nil, p)
		})
		if r.State != "done" {
			log.Printf("Indexing failed: %s", r.Error)
			out.Error("", ipc.EventIndexError, r.Error)
			return
		}
		db.ClearCache()
		out.OK("", ipc.EventIndexDone, nil, r.Stats)
	}

	// An indexer started by an earlier sidecar may still be running.
	if indexer.IsRunning(*dbPath) {
		log.Println("Indexing already in progress, following it...")
		indexing.Store(true)
		go follow(0)
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
			out.OK(req.ID, req.Type, nil, ipc.Status{
				Indexing:  indexing.Load(),
				IndexedAt: indexedAt,
				FileCount: count,
			})

		case ipc.TypeReindex:
			if !indexing.CompareAndSwap(false, true) {
				out.ErrorCode(req.ID, req.Type, ipc.CodeBusy, "indexing is already running")
				continue
			}
			// LaunchElevated blocks until the user answers the UAC prompt,
			// so keep reading requests meanwhile.
			go func(id string) {
				proc, err := indexer.LaunchElevated(*dbPath, *settingsPath)
				if err != nil {
					indexing.Store(false)
					code := ""
					if errors.Is(err, indexer.ErrAdminDenied) {
						code = ipc.CodeAdminDenied
					}
					out.ErrorCode(id, ipc.TypeReindex, code, err.Error())
					return
				}
				out.OK(id, ipc.TypeReindex, nil, nil)
				follow(proc)
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
