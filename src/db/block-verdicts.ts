// ABOUTME: Blocklist version, cached judgments, proposal rows, and the global
// ABOUTME: per-minute call cap. Deterministic matching stays in queries.ts.

import {
  JUDGED_CATEGORIES,
  classifyName,
  plainMatchGlob,
  type ListedTerm,
  type NameClassification,
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
    leet: row.match_leet !== 0,
    digitExpand: row.match_digit_expand !== 0,
    repeats: row.match_repeats !== 0,
    plain: row.match_plain === 1,
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
    judgeEmbeddings: JUDGED_CATEGORIES.has(row.category),
  }))
}

export function classifyReserved(canonical: string, terms: ListedTerm[]): NameClassification {
  return classifyName(canonical, terms)
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
  version: number
): Promise<'blocked' | 'clear' | null> {
  const row = await db.prepare(
    'SELECT verdict FROM block_verdicts WHERE canonical = ? AND blocklist_version = ?'
  ).bind(canonical, version).first<{ verdict: 'blocked' | 'clear' }>()
  return row?.verdict ?? null
}

export async function putBlockVerdict(
  db: D1Database,
  canonical: string,
  version: number,
  verdict: 'blocked' | 'clear',
  now: number
): Promise<void> {
  await db.prepare(
    `INSERT INTO block_verdicts (canonical, blocklist_version, verdict, created_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(canonical, blocklist_version) DO UPDATE SET verdict = excluded.verdict, created_at = excluded.created_at`
  ).bind(canonical, version, verdict, now).run()
}

/** Reserves one call in this minute. False when the cap is already met. */
export async function tryConsumeJevCall(
  db: D1Database,
  minuteBucket: number,
  cap: number
): Promise<boolean> {
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
  leet: true,
  digitExpand: false,
  repeats: false,
  plain: true,
}

/** One lookup for names approval would block, under the rules approval writes. */
export async function countNamesContaining(db: D1Database, word: string): Promise<number> {
  const glob = plainMatchGlob(word, APPROVAL_RULES)
  if (!glob) return 0
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM usernames
     WHERE (
       username_canonical NOT LIKE 'xn--%'
       AND ?1 NOT LIKE 'xn--%'
       AND REPLACE(REPLACE(REPLACE(username_canonical, '-', ''), '_', ''), '.', '') GLOB ?2
     ) OR username_canonical = ?1`
  ).bind(word.toLowerCase(), glob).first<{ n: number }>()
  return row?.n ?? 0
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
