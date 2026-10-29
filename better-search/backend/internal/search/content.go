package search

import (
	"context"
	"os"

	"better-search/backend/internal/database"
	"better-search/backend/internal/winsearch"
)

// Content returns files whose contents contain every word of query, as
// Windows Search finds them, its best matches first. The index adds what it
// knows of each (its id, for ranking opens, and usage); a file it doesn't
// have yet is checked on disk instead. skip, if not nil, leaves out what the
// app's exclusions do. Cancelling ctx stops it, with ctx's error.
func Content(ctx context.Context, db *database.DB, ws *winsearch.Searcher, query string, limit int, skip Skip) ([]Result, error) {
	if limit <= 0 {
		limit = defaultLimit
	}
	limit = min(limit, maxLimit)
	// Some are left out below (excluded folders mostly): ask for more, so a
	// full page is usually still left. Not many more: Windows takes longer
	// the more rows it ranks, ~30% from 100 to 150 for a common word.
	paths, err := ws.Search(ctx, query, limit*2)
	if err != nil {
		return nil, err
	}
	kept := paths[:0]
	for _, p := range paths {
		if len(p) < 3 || p[1] != ':' || p[2] != '\\' {
			continue // not on a drive
		}
		if skip != nil && skip(p, false) {
			continue
		}
		kept = append(kept, p)
		if len(kept) == limit {
			break
		}
	}
	files, err := db.FilesAt(ctx, kept)
	if err != nil {
		return nil, err
	}

	results := make([]Result, 0, len(kept))
	for i, f := range files {
		if f.ID == 0 {
			// New since the index last heard, or gone since Windows did.
			info, err := os.Stat(kept[i])
			if err != nil {
				continue
			}
			f.Size, f.ModifiedAt, f.IsDir = info.Size(), info.ModTime().Unix(), info.IsDir()
		}
		if f.IsDir {
			continue
		}
		results = append(results, Result{
			ID:         f.ID,
			Name:       f.Name,
			Path:       kept[i],
			Type:       "file",
			Size:       f.Size,
			ModifiedAt: f.ModifiedAt,
			OpenCount:  f.OpenCount,
		})
	}
	return results, ctx.Err()
}
