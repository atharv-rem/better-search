// The file watcher (better-search-watcher.exe): keeps the index up to date
// from filesystem changes for as long as the app runs.
package main

import (
	"flag"
	"log"
	"os"

	"better-search/backend/internal/database"
	"better-search/backend/internal/watcher"
)

func main() {
	dbPath := flag.String("db", database.DefaultPath(), "path to the SQLite index")
	settingsPath := flag.String("settings", "", "the app's settings.json, for the user's indexing exclusions")
	flag.Parse()
	// The app timestamps each line, and reads a leading "ERROR: " or "WARN: "
	// as its level.
	log.SetFlags(0)
	os.Exit(watcher.Run(*dbPath, *settingsPath))
}
