// ABOUTME: Runs the real migration chain in an in-memory SQLite database and
// ABOUTME: exposes it through the D1 surface, so query SQL is executed, not mocked.

// Node built-ins are declared in ./node-builtins.d.ts — see the note there.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

type SqliteHandle = {
  exec(sql: string): void
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  }
  close(): void
}
type DatabaseSyncCtor = new (path: string) => SqliteHandle

export type SqliteDb = SqliteHandle

let cachedCtor: DatabaseSyncCtor | null | undefined

/**
 * `node:sqlite` landed in Node 22.5. Suites that need a real database gate on
 * `sqliteAvailable()` so they skip cleanly on older runtimes.
 */
function loadDatabaseSync(): DatabaseSyncCtor | null {
  if (cachedCtor === undefined) {
    try {
      const load = createRequire(import.meta.url)
      cachedCtor = (load('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync
    } catch {
      cachedCtor = null
    }
  }
  return cachedCtor
}

export function sqliteAvailable(): boolean {
  return loadDatabaseSync() !== null
}

/** Migration filenames in the order `wrangler d1 migrations apply` runs them. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort()
}

/** Raw SQL of the migration whose filename starts with `prefix`. */
export function migrationSql(prefix: string): string {
  const file = migrationFiles().find((name) => name.startsWith(prefix))
  if (!file) throw new Error(`No migration matching ${prefix}`)
  return readFileSync(MIGRATIONS_DIR + file, 'utf8')
}

/** Empty database with foreign keys on, matching D1. */
export function createSqlite(): SqliteDb {
  const DatabaseSync = loadDatabaseSync()
  if (!DatabaseSync) throw new Error('node:sqlite is unavailable')
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  return sqlite
}

/**
 * Apply migrations in order. `stopBefore` halts immediately before the named
 * file so a test can seed pre-migration rows and then apply that migration
 * against them.
 */
export function applyMigrations(db: SqliteDb, options: { stopBefore?: string } = {}): void {
  for (const file of migrationFiles()) {
    if (options.stopBefore && file.startsWith(options.stopBefore)) return
    db.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'))
  }
}

/** Index names currently guarding one owned name per pubkey. */
export function pubkeyIndexNames(db: SqliteDb): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_usernames_pubkey%'")
    .all()
    .map((row) => (row as { name: string }).name)
}

function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value
}

function isRead(sql: string): boolean {
  return /^\s*(SELECT|WITH|PRAGMA)/i.test(sql)
}

/**
 * Wrap a SQLite handle in the subset of the D1 API the query layer uses.
 * `batch` mirrors D1: one transaction, statements executed in order, so a
 * later statement observes an earlier one's writes.
 */
export function asD1(db: SqliteDb): D1Database {
  function execute(sql: string, params: unknown[]) {
    const statement = db.prepare(sql)
    if (isRead(sql)) return { rows: statement.all(...params), meta: { changes: 0, last_row_id: 0 } }
    const result = statement.run(...params)
    return {
      rows: [] as unknown[],
      meta: { changes: toNumber(result.changes), last_row_id: toNumber(result.lastInsertRowid) },
    }
  }

  function prepare(sql: string, params: unknown[] = []): D1PreparedStatement {
    return {
      bind: (...next: unknown[]) => prepare(sql, next),
      first: async () => execute(sql, params).rows[0] ?? null,
      all: async () => {
        const { rows, meta } = execute(sql, params)
        return { results: rows, success: true, meta }
      },
      run: async () => {
        const { rows, meta } = execute(sql, params)
        return { results: rows, success: true, meta }
      },
      raw: async () => execute(sql, params).rows,
    } as unknown as D1PreparedStatement
  }

  return {
    prepare: (sql: string) => prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      db.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
}

/** Fresh in-memory database with the full migration chain applied. */
export function createSqliteD1(): { db: D1Database; sqlite: SqliteDb } {
  const sqlite = createSqlite()
  applyMigrations(sqlite)
  return { db: asD1(sqlite), sqlite }
}

/** Insert a `usernames` row with test-friendly defaults. */
export function seedUsername(
  sqlite: SqliteDb,
  row: { name: string; canonical?: string; pubkey?: string | null; status?: string; recyclable?: number }
): void {
  const canonical = row.canonical ?? row.name.toLowerCase()
  sqlite.prepare(
    `INSERT INTO usernames (name, username_display, username_canonical, pubkey, status, recyclable, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 100, 100)`
  ).run(row.name, row.name, canonical, row.pubkey ?? null, row.status ?? 'active', row.recyclable ?? 1)
}
