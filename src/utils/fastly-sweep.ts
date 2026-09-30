// ABOUTME: Slowly reconciles every D1 name, including rows outside the delta window.
import type { Username } from '../db/queries'
import type { FastlyEnv } from './fastly-sync'
import { reconcileUsernameFastly } from './username-fastly-reconcile'

export async function sweepFastlyNames(env: FastlyEnv & { DB: D1Database }): Promise<void> {
  if (!env.FASTLY_API_TOKEN || !env.FASTLY_STORE_ID) return
  const cursor = await env.DB.prepare('SELECT after_id FROM fastly_sweep_cursor WHERE id = 1').first<{ after_id: number }>()
  if (!cursor) throw new Error('Fastly sweep cursor is missing')
  const page = await env.DB.prepare('SELECT * FROM usernames WHERE id > ? ORDER BY id LIMIT ?')
    .bind(cursor.after_id, 100).all<Username>()
  // Re-read each row during reconciliation; page snapshots are not ownership
  // authority. Failed KV operations stay in the generation-safe retry queue.
  for (const row of page.results) {
    await reconcileUsernameFastly(env, row.username_canonical || row.name)
  }
  const next = page.results.length === 100 ? page.results[99].id : 0
  await env.DB.prepare('UPDATE fastly_sweep_cursor SET after_id = ? WHERE id = 1 AND after_id = ?')
    .bind(next, cursor.after_id).run()
}
