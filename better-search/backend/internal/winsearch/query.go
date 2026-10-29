// Package winsearch asks Windows Search, Windows' own index of what's inside
// files, which files contain some words. Nothing is read from the files or
// stored here: Windows keeps that index up to date itself.
package winsearch

import (
	"strconv"
	"strings"
	"unicode"
)

// maxWords keeps a pasted paragraph from becoming a query Windows takes
// seconds over.
const maxWords = 8

// buildSQL is the Windows Search SQL for files containing every word of
// query, each as a prefix ("invo" finds "invoice"), best match first; false
// when query has no words. Only file system items (SCOPE='file:'), so not
// Outlook mail. node_modules is left out in the query, as it can fill the
// whole result with license and readme files; the app's other exclusions
// are applied to the paths that come back (search.Content).
func buildSQL(query string, top int) (string, bool) {
	var terms []string
	for _, w := range words(query) {
		// Single quotes end the SQL string literal: doubled, they're one.
		terms = append(terms, `"`+strings.ReplaceAll(w, "'", "''")+`*"`)
		if len(terms) == maxWords {
			break
		}
	}
	if len(terms) == 0 {
		return "", false
	}
	return "SELECT TOP " + strconv.Itoa(top) + " System.ItemPathDisplay FROM SystemIndex" +
		" WHERE SCOPE='file:'" +
		" AND CONTAINS(System.Search.Contents,'" + strings.Join(terms, " AND ") + "')" +
		` AND NOT CONTAINS(System.ItemFolderPathDisplay,'"node_modules"')` +
		" ORDER BY System.Search.Rank DESC", true
}

// words splits query where Windows' word breaker would: at anything but
// letters, digits and apostrophes inside a word ("don't"). Windows rejects a
// search word that is only punctuation, and quotes or * would change the
// query's meaning.
func words(query string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(query, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '\'' && r != '’'
	}) {
		if w = strings.Trim(w, "'’"); w != "" {
			out = append(out, w)
		}
	}
	return out
}

// splitRows reads the paths out of ADO's GetString output: a path per line,
// which a file name can't break, as Windows doesn't allow control characters
// in names.
func splitRows(s string) []string {
	var paths []string
	for _, line := range strings.Split(s, "\n") {
		if line = strings.TrimRight(line, "\t\r"); line != "" {
			paths = append(paths, line)
		}
	}
	return paths
}
