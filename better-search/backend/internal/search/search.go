package search

import (
	"context"
	"strings"

	"better-search/backend/internal/database"
)

const (
	defaultLimit = 50
	maxLimit     = 500
)

type Result struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"` // "file" or "directory"
	Size       int64  `json:"size"`
	ModifiedAt int64  `json:"modified_at"`
	OpenCount  int64  `json:"open_count"`
}

// Search returns files whose names contain every space-separated word in
// query, best matches first. Cancelling ctx stops it, with ctx's error.
func Search(ctx context.Context, db *database.DB, query string, limit int) ([]Result, error) {
	query = strings.TrimSpace(query)
	terms := strings.Fields(query)
	if len(terms) == 0 {
		return []Result{}, nil
	}
	if limit <= 0 {
		limit = defaultLimit
	}
	limit = min(limit, maxLimit)

	files, err := db.SearchNames(ctx, query, terms, limit)
	if err != nil {
		return nil, err
	}
	paths, err := db.Paths(ctx, files)
	if err != nil {
		return nil, err
	}

	results := make([]Result, 0, len(files))
	for i, f := range files {
		path := paths[i]
		if path == "" {
			continue // its folders are missing; skip rather than show a wrong path
		}
		typ := "file"
		if f.IsDir {
			typ = "directory"
		}
		results = append(results, Result{
			ID:         f.ID,
			Name:       f.Name,
			Path:       path,
			Type:       typ,
			Size:       f.Size,
			ModifiedAt: f.ModifiedAt,
			OpenCount:  f.OpenCount,
		})
	}
	return results, nil
}
