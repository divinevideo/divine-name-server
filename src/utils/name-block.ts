// ABOUTME: Resolves a username against the blocklist. Deterministic hits never
// ABOUTME: call out. Ambiguous names are judged once, then cached, and refused
// ABOUTME: if the judgment cannot be made.

import { classifyName, compileTerm, type ListedTerm } from './blocklist-match'
import { formatReading, readingsFor, type Reading } from './segment'
import { getLexicon } from './lexicon'
import { JevUnavailable, judgeIntent, judgeProposal, type JevFetch } from './jev'
import {
  getBlockVerdict,
  getBlocklistVersion,
  listReservedWordsForMatch,
  proposalExists,
  proposeBlockWord,
  putBlockVerdict,
  tryConsumeJevCall,
} from '../db/block-verdicts'

export interface BlockEnv {
  TYPESAFE_API_KEY?: string
  JEV_BLOCK_MIN?: string
  JEV_PROPOSE_MIN?: string
  JEV_MAX_CALLS_PER_MINUTE?: string
}

export type BlockOutcome =
  | { kind: 'clear' }
  | { kind: 'reserved' }
  | { kind: 'unavailable' }

const DEFAULT_CALLS_PER_MINUTE = 30

function parseUnit(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 1) return undefined
  return n
}

function parseCap(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_CALLS_PER_MINUTE
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) return DEFAULT_CALLS_PER_MINUTE
  return n
}

function termMatcher(term: ListedTerm): (span: string) => boolean {
  const pattern = new RegExp(`^(?:${compileTerm(term.word, term.rules).source})$`)
  return (span) => pattern.test(span)
}

function proposalCandidate(reading: Reading | null, flagged: string, listed: Set<string>): string | null {
  if (!reading) return null
  const candidates = reading.segments
    .filter((segment) => /^[a-z]{4,}$/.test(segment) && segment !== flagged && !listed.has(segment))
    .sort((a, b) => b.length - a.length)
  return candidates[0] ?? null
}

async function maybePropose(
  db: D1Database,
  env: BlockEnv,
  apiKey: string,
  reading: Reading | null,
  flagged: string,
  listed: Set<string>,
  fetchImpl: JevFetch,
  now: number
): Promise<void> {
  const min = parseUnit(env.JEV_PROPOSE_MIN)
  if (min === undefined) return
  const word = proposalCandidate(reading, flagged, listed)
  if (!word) return
  if (await proposalExists(db, word)) return
  const allowed = await tryConsumeJevCall(db, Math.floor(now / 60), parseCap(env.JEV_MAX_CALLS_PER_MINUTE))
  if (!allowed) return
  try {
    const answer = await judgeProposal(apiKey, word, fetchImpl)
    if (answer.noul >= min) await proposeBlockWord(db, word, answer.noul, now)
  } catch (error) {
    if (!(error instanceof JevUnavailable)) throw error
  }
}

/**
 * Deterministic block or clear returns immediately. Ambiguous names are refused
 * when the key, the measured threshold, the cap, or the service is missing.
 * A verdict is cached only after a real judgment, keyed by blocklist version.
 */
export async function resolveUsernameBlock(
  db: D1Database,
  canonical: string,
  env: BlockEnv,
  fetchImpl: JevFetch = fetch,
  now = Math.floor(Date.now() / 1000),
  allowJudgment = true
): Promise<BlockOutcome> {
  const terms = await listReservedWordsForMatch(db)
  const classification = classifyName(canonical, terms)
  if (classification.verdict === 'blocked') return { kind: 'reserved' }
  if (classification.verdict === 'clear') return { kind: 'clear' }

  const threshold = parseUnit(env.JEV_BLOCK_MIN)
  const apiKey = env.TYPESAFE_API_KEY
  if (!apiKey || threshold === undefined) return { kind: 'unavailable' }

  const version = await getBlocklistVersion(db)
  const cached = await getBlockVerdict(db, canonical, version)
  if (cached === 'blocked') return { kind: 'reserved' }
  if (cached === 'clear') return { kind: 'clear' }
  if (!allowJudgment) return { kind: 'unavailable' }

  const listed = new Set(terms.map((term) => term.word))
  const cap = parseCap(env.JEV_MAX_CALLS_PER_MINUTE)
  let blocked = false
  let guilty: { word: string; reading: Reading | null } | null = null

  const embedded = classification.embedded
  for (const word of embedded) {
    const term = terms.find((item) => item.word === word)
    if (!term) return { kind: 'unavailable' }
    const allowed = await tryConsumeJevCall(db, Math.floor(now / 60), cap)
    if (!allowed) return { kind: 'unavailable' }
    const pair = readingsFor(canonical, getLexicon(), termMatcher(term))
    try {
      const answer = await judgeIntent(
        apiKey,
        canonical,
        word,
        formatReading(pair.withWord),
        formatReading(pair.withoutWord),
        fetchImpl
      )
      if (answer.noul >= threshold) {
        blocked = true
        guilty = { word, reading: pair.withWord }
        break
      }
    } catch (error) {
      if (error instanceof JevUnavailable) return { kind: 'unavailable' }
      throw error
    }
  }

  // Reaching this point without a block means every embedded word was judged.
  await putBlockVerdict(db, canonical, version, blocked ? 'blocked' : 'clear', now)
  if (blocked && guilty) {
    await maybePropose(db, env, apiKey, guilty.reading, guilty.word, listed, fetchImpl, now)
  }
  return blocked ? { kind: 'reserved' } : { kind: 'clear' }
}
