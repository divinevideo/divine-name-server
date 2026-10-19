// ABOUTME: Blocklist version, cached judgments, proposal rows, and the global
// ABOUTME: per-minute call cap. Deterministic matching stays in queries.ts.

import {
  compileTerm,
  judgesEmbeddings,
  matchesTerm,
  plainMatchGlob,
  type ListedTerm,
  type TermRules,
} from '../utils/blocklist-match'

interface MatchRow {
  word: string
  category: string
  match_scope: string
  match_leet: number
  match_digit_expand: number
  match_repeats: number
  match_plain: number
}

function rulesOf(row: MatchRow): TermRules {
  return {
    scope: row.match_scope === 'token' || row.match_scope === 'anywhere' ? 'token' : 'whole',
    digitExpand: row.match_digit_expand !== 0,
    repeats: row.match_repeats !== 0,
    plain: false,
  }
}

export async function listReservedWordsForMatch(db: D1Database): Promise<ListedTerm[]> {
  const { results } = await db.prepare(
    `SELECT word, category, match_scope, match_leet, match_digit_expand, match_repeats, match_plain
     FROM reserved_words`
  ).all<MatchRow>()
  return results.map((row) => ({
    word: row.word,
    rules: rulesOf(row),
    judgeEmbeddings: judgesEmbeddings(row.word, row.category),
  }))
}

export async function getBlocklistVersion(db: D1Database): Promise<number> {
  const row = await db.prepare(
    'SELECT version FROM blocklist_meta WHERE id = 1'
  ).first<{ version: number }>()
  return row?.version ?? 1
}

export async function bumpBlocklistVersion(db: D1Database): Promise<void> {
  await db.prepare(
    'UPDATE blocklist_meta SET version = version + 1 WHERE id = 1'
  ).run()
}

export async function getBlockVerdict(
  db: D1Database,
  canonical: string,
  version: number,
  threshold: number | string
): Promise<'blocked' | 'clear' | null> {
  const row = await db.prepare(
    `SELECT verdict FROM block_verdicts
     WHERE canonical = ? AND blocklist_version = ? AND threshold = ?`
  ).bind(canonical, version, String(threshold)).first<{ verdict: 'blocked' | 'clear' }>()
  return row?.verdict ?? null
}

export async function putBlockVerdict(
  db: D1Database,
  canonical: string,
  version: number,
  threshold: number | string,
  verdict: 'blocked' | 'clear',
  now: number
): Promise<void> {
  await db.prepare(
    `INSERT INTO block_verdicts (canonical, blocklist_version, threshold, verdict, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(canonical, blocklist_version, threshold) DO UPDATE SET
       verdict = excluded.verdict, created_at = excluded.created_at`
  ).bind(canonical, version, String(threshold), verdict, now).run()
}

/** Drop verdicts for a replaced blocklist, and bound the rolling call buckets. */
export async function pruneBlocklistData(db: D1Database, now: number): Promise<void> {
  const version = await getBlocklistVersion(db)
  await db.batch([
    db.prepare('DELETE FROM block_verdicts WHERE blocklist_version <> ?')
      .bind(version),
    db.prepare('DELETE FROM jev_call_buckets WHERE minute_bucket < ?')
      .bind(Math.floor(now / 60) - 24 * 60),
  ])
}

/** Reserves one call in this minute. False when the cap is already met. */
export async function tryConsumeJudgmentCall(
  db: D1Database,
  minuteBucket: number,
  cap: number
): Promise<boolean> {
  if (cap < 1) return false
  const row = await db.prepare(
    `INSERT INTO jev_call_buckets (minute_bucket, calls) VALUES (?1, 1)
     ON CONFLICT(minute_bucket) DO UPDATE SET calls = calls + 1
     WHERE calls < ?2
     RETURNING calls`
  ).bind(minuteBucket, cap).first<{ calls: number }>()
  return row !== null
}

export async function proposalExists(db: D1Database, word: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT word FROM blocklist_proposals WHERE word = ?'
  ).bind(word).first<{ word: string }>()
  return row !== null
}

export async function proposeBlockWord(
  db: D1Database,
  word: string,
  confidence: number,
  now: number
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO blocklist_proposals (word, status, confidence, created_at)
     VALUES (?1, 'pending', ?2, ?3)`
  ).bind(word, confidence, now).run()
}

export interface BlockProposal {
  word: string
  status: string
  confidence: number
  created_at: number
  affected_count: number
}

const APPROVAL_RULES: TermRules = {
  scope: 'token',
  digitExpand: false,
  repeats: false,
  plain: false,
}

/** One lookup for names approval would block, under the rules approval writes. */
export async function countNamesContaining(db: D1Database, word: string): Promise<number> {
  // Approval preserves an existing row's expansion/repeat settings. Count with
  // those settings too if the word was added while its proposal was pending.
  const existing = await db.prepare(
    'SELECT match_digit_expand, match_repeats FROM reserved_words WHERE word = ?'
  ).bind(word).first<{ match_digit_expand: number; match_repeats: number }>()
  const rules = { ...APPROVAL_RULES, digitExpand: !!existing?.match_digit_expand, repeats: !!existing?.match_repeats }
  const glob = plainMatchGlob(word, rules)
  const compiled = compileTerm(word.toLowerCase(), rules)
  let afterId = 0
  let count = 0
  // A broad/short term must not materialize the registry in one D1 response.
  // Repeated-character rules have no bounded GLOB prefilter; page that scan too.
  while (true) {
    const page = await db.prepare(
      `SELECT id, username_canonical FROM usernames
       WHERE id > ?3 AND (?2 IS NULL OR username_canonical = ?1
         OR REPLACE(REPLACE(REPLACE(username_canonical, '-', ''), '_', ''), '.', '') GLOB ?2)
       ORDER BY id LIMIT 1000`
    ).bind(word.toLowerCase(), glob, afterId).all<{ id: number; username_canonical: string }>()
    for (const row of page.results) {
      if (matchesTerm(row.username_canonical, word.toLowerCase(), rules, compiled)) count++
      afterId = row.id
    }
    if (page.results.length < 1000) return count
  }
}

export async function listPendingProposals(db: D1Database): Promise<BlockProposal[]> {
  const { results } = await db.prepare(
    `SELECT word, status, confidence, created_at FROM blocklist_proposals
     WHERE status = 'pending' ORDER BY created_at`
  ).all<{ word: string; status: string; confidence: number; created_at: number }>()
  const out: BlockProposal[] = []
  for (const row of results) {
    out.push({ ...row, affected_count: await countNamesContaining(db, row.word) })
  }
  return out
}

export async function approveProposal(
  db: D1Database,
  word: string,
  resolvedBy: string | null,
  now: number
): Promise<boolean> {
  const pending = await db.prepare(
    `SELECT word FROM blocklist_proposals WHERE word = ? AND status = 'pending'`
  ).bind(word).first<{ word: string }>()
  if (!pending) return false

  await db.prepare(
    `INSERT INTO reserved_words (word, category, reason, created_at, match_scope, match_plain)
     VALUES (?1, 'offensive', 'Approved from judgment proposal', ?2, 'token', 1)
     ON CONFLICT(word) DO UPDATE SET match_plain = 1, match_scope = 'token'`
  ).bind(word, now).run()

  await db.prepare(
    `UPDATE blocklist_proposals
     SET status = 'approved', resolved_at = ?2, resolved_by = ?3
     WHERE word = ?1 AND status = 'pending'`
  ).bind(word, now, resolvedBy).run()
  await bumpBlocklistVersion(db)
  return true
}

export async function rejectProposal(
  db: D1Database,
  word: string,
  resolvedBy: string | null,
  now: number
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE blocklist_proposals
     SET status = 'rejected', resolved_at = ?2, resolved_by = ?3
     WHERE word = ?1 AND status = 'pending'`
  ).bind(word, now, resolvedBy).run()
  return (result.meta?.changes ?? 0) > 0
}
