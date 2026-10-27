package database

import (
	"bytes"
	"container/heap"
	"sort"
	"unicode/utf8"
)

// Search results are ranked here rather than by the search's ORDER BY,
// where SQLite ran a dozen LIKEs on every match before keeping the first
// few: most of a common word's search time.
//
// By kind first: an exact file or a shortcut (.lnk) starting with the query
// or with a word starting with it ("Visual Studio Code"), then apps (.exe)
// starting with the query, then other shortcuts and folders, then other
// files. Within each: exact name, the files the user opens most and most
// recently, names starting with the query, names with a word starting with
// it (after a space, dot, underscore or dash), then shorter names. Case is
// ignored for ASCII letters only, as LIKE and NOCASE ignore it.

// ranked is a match with what it's ranked by, beyond its own fields.
type ranked struct {
	File
	kind   uint8 // 0 best
	exact  bool
	word   uint8 // 0 starts with the query, 1 a word does, 2 neither
	length int   // in characters, as SQLite's length()
}

// before reports whether a ranks above b.
func (a *ranked) before(b *ranked) bool {
	switch {
	case a.kind != b.kind:
		return a.kind < b.kind
	case a.exact != b.exact:
		return a.exact
	case a.OpenCount != b.OpenCount:
		return a.OpenCount > b.OpenCount
	case a.LastOpened != b.LastOpened:
		return a.LastOpened > b.LastOpened // 0, never opened, last
	case a.word != b.word:
		return a.word < b.word
	case a.length != b.length:
		return a.length < b.length
	case a.Name != b.Name:
		return a.Name < b.Name
	}
	return a.ID < b.ID
}

// ranker ranks the matches of one query.
type ranker struct {
	q, qDot                 []byte // lower-cased
	space, dot, under, dash []byte // a word starting with q
	name                    []byte // the name being ranked, lower-cased
}

func newRanker(query string) *ranker {
	q := lowerASCII(nil, query)
	with := func(prefix byte) []byte { return append([]byte{prefix}, q...) }
	return &ranker{q: q, qDot: append(q[:len(q):len(q)], '.'), space: with(' '), dot: with('.'), under: with('_'), dash: with('-')}
}

func (r *ranker) rank(f File) ranked {
	r.name = lowerASCII(r.name[:0], f.Name)
	n := r.name
	lnk := bytes.HasSuffix(n, []byte(".lnk"))
	prefix := bytes.HasPrefix(n, r.q)
	spaceWord := bytes.Contains(n, r.space)
	// "resume" is Resume.pdf, but not resume.tar.gz.
	exact := bytes.Equal(n, r.q) || (bytes.HasPrefix(n, r.qDot) && bytes.IndexByte(n[len(r.qDot):], '.') < 0)

	out := ranked{File: f, kind: 3, word: 2, exact: exact, length: utf8.RuneCountInString(f.Name)}
	switch {
	case lnk && (prefix || spaceWord):
		out.kind = 0
	case f.IsDir || lnk:
		out.kind = 2
	case exact:
		out.kind = 0
	case prefix && bytes.HasSuffix(n, []byte(".exe")):
		out.kind = 1
	}
	switch {
	case prefix:
		out.word = 0
	case spaceWord || bytes.Contains(n, r.dot) || bytes.Contains(n, r.under) || bytes.Contains(n, r.dash):
		out.word = 1
	}
	return out
}

// lowerASCII appends s with its ASCII letters lower-cased, which keeps its
// length in bytes.
func lowerASCII(dst []byte, s string) []byte {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		dst = append(dst, c)
	}
	return dst
}

// topN keeps the best limit matches seen, the worst of them first.
type topN []ranked

func (h topN) Len() int           { return len(h) }
func (h topN) Less(i, j int) bool { return h[j].before(&h[i]) }
func (h topN) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *topN) Push(x any)        { *h = append(*h, x.(ranked)) }
func (h *topN) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

// add offers a match, keeping it if it's among the best limit so far.
func (h *topN) add(r ranked, limit int) {
	switch {
	case len(*h) < limit:
		heap.Push(h, r)
	case r.before(&(*h)[0]):
		(*h)[0] = r
		heap.Fix(h, 0)
	}
}

// files are the kept matches, best first.
func (h topN) files() []File {
	sort.Slice(h, func(i, j int) bool { return h[i].before(&h[j]) })
	out := make([]File, len(h))
	for i := range h {
		out[i] = h[i].File
	}
	return out
}
