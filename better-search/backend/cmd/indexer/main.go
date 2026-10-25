// The indexer (better-search-indexer.exe): reads the drives' file tables and
// sends what it finds to the search helper that started it, over the pipe
// named on its command line, then exits. The helper starts it as
// administrator, which reading those tables needs.
package main

import (
	"flag"
	"os"

	"better-search/backend/internal/indexer"
)

func main() {
	pipe := flag.String("pipe", "", "the search helper's pipe to send the index to")
	flag.Parse()
	os.Exit(indexer.RunChild(*pipe))
}
