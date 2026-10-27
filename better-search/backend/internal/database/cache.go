package database

import (
	"context"
	"database/sql"
	"fmt"
	"reflect"
	"unsafe"

	"modernc.org/libc"
	sqlite3 "modernc.org/sqlite/lib"
)

// CacheLimit is the page cache each connection may fill (cache_size in Open).
// Small, as reads come from the memory-mapped file (mmapSize).
const CacheLimit = 4 << 20

// mmapSize is how much of the index file is read through a memory map:
// beyond any index this app builds, so all of it.
const mmapSize = 2 << 30

// bulkCacheSize is the page cache (in KiB, as cache_size takes it) for a full
// index's write transaction, which writes far more pages than it reads.
const bulkCacheSize = 64 << 10

// CacheUsed is the memory SQLite's page cache holds across the pool's open
// connections, in bytes.
func (d *DB) CacheUsed(ctx context.Context) (int64, error) {
	// Hold as many connections as are open so each one is counted once; a
	// connection opened here because another is busy adds an empty cache.
	n := d.sql.Stats().OpenConnections
	conns := make([]*sql.Conn, 0, n)
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()

	var total int64
	for range max(n, 1) {
		c, err := d.sql.Conn(ctx)
		if err != nil {
			return 0, err
		}
		conns = append(conns, c)
		if err := c.Raw(func(dc any) error {
			used, err := connCacheUsed(dc)
			total += used
			return err
		}); err != nil {
			return 0, err
		}
	}
	return total, nil
}

// connCacheUsed calls sqlite3_db_status(SQLITE_DBSTATUS_CACHE_USED) on a
// modernc.org/sqlite connection. The driver has no API for it (and builds
// SQLite with SQLITE_DEFAULT_MEMSTATUS=0, so the global sqlite3_status
// counters stay at 0), so this reads the connection's handle and thread state
// from its unexported db and tls fields.
func connCacheUsed(driverConn any) (int64, error) {
	v := reflect.ValueOf(driverConn)
	if v.Kind() != reflect.Pointer || v.Elem().Kind() != reflect.Struct {
		return 0, fmt.Errorf("unexpected driver connection %T", driverConn)
	}
	dbField, tlsField := v.Elem().FieldByName("db"), v.Elem().FieldByName("tls")
	if dbField.Kind() != reflect.Uintptr || tlsField.Kind() != reflect.Pointer || tlsField.IsNil() {
		return 0, fmt.Errorf("driver connection %T has no db/tls fields", driverConn)
	}
	db := uintptr(dbField.Uint())
	tls := (*libc.TLS)(unsafe.Pointer(tlsField.Pointer()))

	p := tls.Alloc(8) // int current, int highwater
	defer tls.Free(8)
	if rc := sqlite3.Xsqlite3_db_status(tls, db, sqlite3.SQLITE_DBSTATUS_CACHE_USED, p, p+4, 0); rc != sqlite3.SQLITE_OK {
		return 0, fmt.Errorf("sqlite3_db_status: code %d", rc)
	}
	// p is libc heap memory, not Go memory, so the GC never moves it (go vet
	// can't tell and warns).
	return int64(*(*int32)(unsafe.Pointer(p))), nil
}

// Trim frees what the index holds in memory while the app is idle: the idle
// connection's page cache, which refills from the memory-mapped file on the
// next search.
func (d *DB) Trim() {
	d.sql.SetMaxIdleConns(0) // closes the idle connection
	d.sql.SetMaxIdleConns(1)
}
