// ABOUTME: Score migration compatibility and aggregate-only judgment statistics.
import { afterEach, describe, expect, it } from 'vitest'
import { applyMigrations, asD1, createSqlite, createSqliteD1, migrationSql, sqliteAvailable, type SqliteDb } from './sqlite-test-helpers'
import { getBlockVerdict, getJudgmentStats, putBlockVerdict } from './block-verdicts'

const databases: SqliteDb[] = []
afterEach(() => { for (const sqlite of databases.splice(0)) sqlite.close() })

describe.skipIf(!sqliteAvailable())('judgment score migration', () => {
  it('preserves existing data and explicit-column reads/writes from the old code', async () => {
    const sqlite = createSqlite(); databases.push(sqlite)
    applyMigrations(sqlite, { stopBefore: '0018' })
    sqlite.prepare('INSERT INTO block_verdicts VALUES (?, ?, ?, ?, ?)')
      .run('zxqwordextra', 1, 'clef-intent-v1:0.6', 'clear', 100)
    sqlite.exec(migrationSql('0018'))
    expect(sqlite.prepare('SELECT verdict, created_at, score FROM block_verdicts').get()).toEqual({
      verdict: 'clear', created_at: 100, score: null,
    })
    const scoreColumn = (sqlite.prepare('PRAGMA table_info(block_verdicts)').all() as Array<{ name: string; type: string; notnull: number }>)
      .find(column => column.name === 'score')
    expect(scoreColumn).toMatchObject({ type: 'REAL', notnull: 0 })
    // The deployed predecessor's column list must remain valid after applying.
    sqlite.prepare('INSERT INTO block_verdicts (canonical, blocklist_version, threshold, verdict, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('zxqwordalpha', 1, 'clef-intent-v1:0.6', 'blocked', 200)
    expect(await getBlockVerdict(asD1(sqlite), 'zxqwordalpha', 1, 'clef-intent-v1:0.6')).toBe('blocked')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM block_verdicts WHERE score IS NULL').get()).toEqual({ n: 2 })
    expect(sqlite.prepare('SELECT version FROM blocklist_meta').get()).toEqual({ version: 1 })
  })

  it('bounds non-null scores and leaves null, zero and one valid', () => {
    const { sqlite } = createSqliteD1(); databases.push(sqlite)
    sqlite.prepare('INSERT INTO block_verdicts (canonical, blocklist_version, threshold, verdict, created_at) VALUES (?, 1, ?, ?, 100)')
      .run('zxqwordextra', 'clef-intent-v1:0.6', 'clear')
    const update = sqlite.prepare('UPDATE block_verdicts SET score = ?')
    expect(() => update.run(-0.01)).toThrow()
    expect(() => update.run(1.01)).toThrow()
    for (const score of [0, 1, null]) {
      update.run(score)
      expect(sqlite.prepare('SELECT score FROM block_verdicts').get()).toEqual({ score })
    }
  })

  it('updates score and verdict together on a cache upsert', async () => {
    const { db, sqlite } = createSqliteD1(); databases.push(sqlite)
    await putBlockVerdict(db, 'zxqwordextra', 1, 'clef-intent-v1:0.6', 'clear', 100, 0.2)
    await putBlockVerdict(db, 'zxqwordextra', 1, 'clef-intent-v1:0.6', 'blocked', 200, 0.8)
    expect(sqlite.prepare('SELECT verdict, created_at, score FROM block_verdicts').get()).toEqual({
      verdict: 'blocked', created_at: 200, score: 0.8,
    })
  })

  it.each([NaN, Infinity, -0.01, 1.01])('does not turn an invalid new score into an unscored row (%s)', async (score) => {
    const { db, sqlite } = createSqliteD1(); databases.push(sqlite)
    await expect(putBlockVerdict(db, 'zxqwordextra', 1, 'clef-intent-v1:0.6', 'clear', 100, score)).rejects.toThrow('Invalid judgment score')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM block_verdicts').get()).toEqual({ n: 0 })
  })
})

describe.skipIf(!sqliteAvailable())('aggregate judgment statistics', () => {
  it('reports empty data without individual records', async () => {
    const { db, sqlite } = createSqliteD1(); databases.push(sqlite)
    expect(await getJudgmentStats(db, 12_000)).toEqual({
      blocklist_version: 1, cached_verdicts: 0, unscored_verdicts: 0, score_distribution: [],
      call_volume: { start_minute: 141, end_minute: 200, reserved_calls: 0, buckets: [] },
    })
  })

  it('groups by policy, verdict and score range, includes legacy nulls, and bounds call buckets', async () => {
    const { db, sqlite } = createSqliteD1(); databases.push(sqlite)
    const insert = sqlite.prepare('INSERT INTO block_verdicts (canonical, blocklist_version, threshold, verdict, created_at, score) VALUES (?, ?, ?, ?, 100, ?)')
    // Independently constructed synthetic identifiers, never registry data.
    for (const [i, score] of [0, 0.0999, 0.1, 0.65, 0.69, 0.95, 1, null].entries()) {
      insert.run(`zxqword${i}`, 1, 'clef-intent-v1:0.6', score !== null && score >= 0.6 ? 'blocked' : 'clear', score)
    }
    insert.run('zxqwordalpha', 0, 'clef-intent-v1:0.6', 'blocked', 0.99)
    insert.run('zxqwordbravo', 1, '0.5', 'clear', null)
    const bucket = sqlite.prepare('INSERT INTO jev_call_buckets VALUES (?, ?)')
    for (const [minute, calls] of [[140, 9], [141, 2], [199, 3], [200, 4], [201, 5]]) bucket.run(minute, calls)
    const stats = await getJudgmentStats(db, 12_000)
    expect(stats.cached_verdicts).toBe(9)
    expect(stats.unscored_verdicts).toBe(2)
    expect(stats.score_distribution).toEqual([
      { policy: '0.5', verdict: 'clear', lower: null, upper: null, upper_inclusive: false, cached_verdicts: 1 },
      { policy: 'clef-intent-v1:0.6', verdict: 'blocked', lower: 0.6, upper: 0.7, upper_inclusive: false, cached_verdicts: 2 },
      { policy: 'clef-intent-v1:0.6', verdict: 'blocked', lower: 0.9, upper: 1, upper_inclusive: true, cached_verdicts: 2 },
      { policy: 'clef-intent-v1:0.6', verdict: 'clear', lower: null, upper: null, upper_inclusive: false, cached_verdicts: 1 },
      { policy: 'clef-intent-v1:0.6', verdict: 'clear', lower: 0, upper: 0.1, upper_inclusive: false, cached_verdicts: 2 },
      { policy: 'clef-intent-v1:0.6', verdict: 'clear', lower: 0.1, upper: 0.2, upper_inclusive: false, cached_verdicts: 1 },
    ])
    expect(stats.call_volume).toEqual({ start_minute: 141, end_minute: 200, reserved_calls: 9, buckets: [
      { minute_bucket: 141, reserved_calls: 2 }, { minute_bucket: 199, reserved_calls: 3 }, { minute_bucket: 200, reserved_calls: 4 },
    ] })
    const json = JSON.stringify(stats)
    expect(json).not.toContain('zxqword')
    expect(json).not.toContain('canonical')
    expect(json).not.toContain('0.65')
  })
})
