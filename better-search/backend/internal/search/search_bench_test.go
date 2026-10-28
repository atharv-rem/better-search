package search

import (
	"context"
	"os"
	"testing"

	"better-search/backend/internal/database"
)

// Searches a real index, one sub-benchmark per query. Point it at a copy:
//
//	BETTER_SEARCH_BENCH_DB=C:\copy\index.db go test ./internal/search -bench . -benchmem
var benchQueries = []string{
	"a", "re", "doc", "png", "the", "app", "exe", "lib", "log", "new", "data", "test",
	"user", "2024", "setup", "image", "readme", "config", "program", "windows", "mic word",
}

func BenchmarkSearch(b *testing.B) {
	path := os.Getenv("BETTER_SEARCH_BENCH_DB")
	if path == "" {
		b.Skip("BETTER_SEARCH_BENCH_DB not set")
	}
	db, err := database.Open(path)
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()

	ctx := context.Background()
	for _, q := range benchQueries {
		b.Run(q, func(b *testing.B) {
			for b.Loop() {
				if _, err := Search(ctx, db, q, 50, nil); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
