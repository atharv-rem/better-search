package database

import (
	"context"
	"testing"
)

func TestCacheUsed(t *testing.T) {
	db := openTest(t)
	load(t, db, tree)
	names(t, db, "resume")
	used, err := db.CacheUsed(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if used <= 0 || used > CacheLimit*int64(max(db.sql.Stats().OpenConnections, 1)) {
		t.Fatalf("cache used = %d bytes", used)
	}
}
