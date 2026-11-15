// ABOUTME: Allocates a restored creator's name without replacing another owner.
// ABOUTME: Unassigned reservations can activate; collisions use stable bounded alternatives.
import { resolveUsernameBlock, type BlockEnv } from './name-block'
import { validateUsername, UsernameValidationError } from './validation'

type Allocation = { kind: 'assigned'; name: string; created: boolean }
  | { kind: 'reserved' } | { kind: 'unavailable' } | { kind: 'taken' }
interface OwnedName { name: string; username_canonical: string | null; status: string }

async function ownedName(db: D1Database, pubkey: string): Promise<OwnedName | null> {
  return db.prepare(`SELECT name,username_canonical,status FROM usernames
    WHERE LOWER(pubkey)=LOWER(?) AND status IN ('active','pending-release') LIMIT 1`)
    .bind(pubkey).first<OwnedName>()
}

function alternative(canonical: string, pubkey: string, index: number): string {
  const suffix = `-${pubkey.slice(0, 12)}${index ? `-${index + 1}` : ''}`
  // Truncating an encoded IDN would corrupt its spelling. Use a neutral ASCII
  // stem for those names; every candidate still goes through normal policy.
  const stem = canonical.startsWith('xn--') ? 'vine' : canonical
  return stem.slice(0, 63 - suffix.length).replace(/-+$/, '') + suffix
}

export async function allocateImportedName(
  db: D1Database, requested: { display: string; canonical: string }, pubkey: string,
  relays: string[], env: BlockEnv, now: number,
): Promise<Allocation> {
  const requestedPolicy = await resolveUsernameBlock(db, requested.canonical, env, now, false)
  if (requestedPolicy.kind === 'reserved') return requestedPolicy
  if (await db.prepare(`SELECT 1 FROM username_release_attempts
    WHERE state='finalized' AND LOWER(pubkey)=LOWER(?) LIMIT 1`).bind(pubkey).first()) return { kind: 'taken' }

  const reuseOwned = async (owned: OwnedName): Promise<Allocation> => {
    if (owned.status !== 'active') return { kind: 'taken' }
    const name = owned.username_canonical ?? owned.name
    try {
      if (validateUsername(name).canonical !== name) return { kind: 'taken' }
    } catch (error) {
      if (error instanceof UsernameValidationError) return { kind: 'taken' }
      throw error
    }
    const policy = name === requested.canonical ? requestedPolicy : await resolveUsernameBlock(db, name, env, now, false)
    if (policy.kind === 'reserved') return policy
    // No new assignment is made by a replay. An unavailable judgment cannot
    // transfer ownership or drop an address the account already owns.
    return { kind: 'assigned', name, created: false }
  }
  const existing = await ownedName(db, pubkey)
  if (existing) return reuseOwned(existing)
  if (requestedPolicy.kind === 'unavailable') return requestedPolicy

  for (let attempt = 0; attempt <= 8; attempt++) {
    const candidate = attempt === 0 ? requested : validateUsername(alternative(requested.canonical, pubkey, attempt - 1))
    const policy = attempt === 0 ? requestedPolicy : await resolveUsernameBlock(db, candidate.canonical, env, now, false)
    if (policy.kind !== 'clear') {
      if (attempt === 0) return policy
      continue
    }
    const result = await db.prepare(`
      INSERT INTO usernames(name,username_display,username_canonical,pubkey,relays,
        status,claim_source,created_at,updated_at,claimed_at)
      SELECT ?,?,?,?,?,'active','vine-import',?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM reserved_words WHERE word=?)
        AND NOT EXISTS(SELECT 1 FROM username_release_attempts WHERE state='finalized' AND LOWER(pubkey)=LOWER(?))
        AND NOT EXISTS(SELECT 1 FROM usernames WHERE LOWER(pubkey)=LOWER(?) AND status IN ('active','pending-release'))
      ON CONFLICT DO UPDATE SET name=excluded.name,username_display=excluded.username_display,
        username_canonical=excluded.username_canonical,pubkey=excluded.pubkey,relays=excluded.relays,
        status='active',claim_source='vine-import',updated_at=excluded.updated_at,
        claimed_at=excluded.claimed_at,reserved_reason=NULL
      WHERE usernames.status='reserved' AND usernames.pubkey IS NULL AND usernames.reservation_email IS NULL
        AND NOT EXISTS(SELECT 1 FROM usernames clash WHERE clash.id<>usernames.id
          AND(clash.name=excluded.name OR clash.username_canonical=excluded.username_canonical))
    `).bind(candidate.canonical, candidate.display, candidate.canonical, pubkey, JSON.stringify(relays),
      now, now, now, candidate.canonical, pubkey, pubkey).run()
    if (result.meta.changes > 0) return { kind: 'assigned', name: candidate.canonical, created: true }

    // A sibling restore may have won the per-pubkey constraint. Reuse its
    // committed assignment instead of creating a different name on each retry.
    const winner = await ownedName(db, pubkey)
    if (winner) return reuseOwned(winner)
    if (attempt === 0 && await db.prepare('SELECT 1 FROM reserved_words WHERE word=?').bind(candidate.canonical).first())
      return { kind: 'reserved' }
  }
  return { kind: 'unavailable' }
}
