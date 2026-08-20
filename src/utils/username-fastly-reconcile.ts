// ABOUTME: Reconciles one username from authoritative D1 state to Fastly KV.
// ABOUTME: Detects out-of-order transitions and preserves newer queued generations.

import {
  clearFastlySyncTasks,
  enqueueFastlySyncTask,
  getQueuedFastlySyncTask,
  getUsernameByName,
  markFastlySyncTaskFailures,
} from '../db/queries'
import { deleteUsernameFromFastly, parseRelayHints, syncAndVerifyUsername, type FastlyEnv, type SyncItem } from './fastly-sync'

type ReconcileEnv = FastlyEnv & { DB: D1Database }

function desiredItem(username: Awaited<ReturnType<typeof getUsernameByName>>, canonical: string): SyncItem {
  if (username?.status === 'active' && username.pubkey) {
    return {
      username: canonical,
      action: 'sync',
      data: {
        pubkey: username.pubkey,
        relays: parseRelayHints(username.relays),
        status: 'active',
        atproto_did: username.atproto_did,
        atproto_state: username.atproto_state,
      },
    }
  }
  return { username: canonical, action: 'delete' }
}

function sameDesiredState(left: SyncItem, right: SyncItem): boolean {
  return left.action === right.action && JSON.stringify(left.data || null) === JSON.stringify(right.data || null)
}

export async function reconcileUsernameFastly(env: ReconcileEnv, canonical: string): Promise<void> {
  let lastError = 'Fastly state changed during reconciliation'
  for (let pass = 0; pass < 3; pass += 1) {
    const before = desiredItem(await getUsernameByName(env.DB, canonical), canonical)
    await enqueueFastlySyncTask(env.DB, before)
    const queued = await getQueuedFastlySyncTask(env.DB, canonical)

    let operationSucceeded = false
    if (before.action === 'sync' && before.data) {
      const result = await syncAndVerifyUsername(env, canonical, before.data)
      operationSucceeded = result.success && result.verified
      if (!operationSucceeded) lastError = result.error || 'Fastly sync verification failed'
    } else {
      const result = await deleteUsernameFromFastly(env, canonical)
      operationSucceeded = result.success
      if (!operationSucceeded) lastError = result.error || 'Fastly delete failed'
    }

    const after = desiredItem(await getUsernameByName(env.DB, canonical), canonical)
    if (sameDesiredState(before, after)) {
      if (queued && operationSucceeded) {
        await clearFastlySyncTasks(env.DB, [{ username: canonical, generation: queued.generation }])
      } else if (queued) {
        await markFastlySyncTaskFailures(env.DB, [{ username: canonical, error: lastError }])
      }
      return
    }
  }

  const latest = desiredItem(await getUsernameByName(env.DB, canonical), canonical)
  await enqueueFastlySyncTask(env.DB, latest)
}
