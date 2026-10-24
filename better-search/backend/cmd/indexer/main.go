// The indexer (better-search-indexer.exe): builds the whole index from the
// drives' file tables and exits. The search helper starts it as
// administrator, which reading those tables needs.
package main

import (
	"flag"
	"os"

	"better-search/backend/internal/database"
	"better-search/backend/internal/indexer"
)

func main() {
	dbPath := flag.String("db", database.DefaultPath(), "path to the SQLite index")
	settingsPath := flag.String("settings", "", "the app's settings.json, for the user's indexing exclusions")
	flag.Parse()
	os.Exit(indexer.RunChild(*dbPath, *settingsPath))
}
