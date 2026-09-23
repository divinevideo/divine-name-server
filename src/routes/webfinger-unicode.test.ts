// ABOUTME: WebFinger must look a name up the way NIP-05 does — by canonical form.
// ABOUTME: Runs the real lookup SQL, since the bug is which column value is compared.

import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import webfinger from './webfinger'
import { validateUsername } from '../utils/validation'
import { createExecutionContext } from '../db/test-helpers'
import { createSqliteD1, seedUsername, sqliteAvailable } from '../db/sqlite-test-helpers'

// What claimUsername actually stores for `café`: both `name` and
// `username_canonical` hold the punycode form, only the display column keeps
// the Unicode one.
const DISPLAY = 'café'
const CANONICAL = 'xn--caf-dma'
const OWNER = 'a'.repeat(64)

function app() {
  const instance = new Hono<{ Bindings: { DB: D1Database } }>()
  instance.route('', webfinger)
  return instance
}

function seeded() {
  const { db, sqlite } = createSqliteD1()
  seedUsername(sqlite, { name: CANONICAL, display: DISPLAY, pubkey: OWNER, status: 'active' })
  seedUsername(sqlite, { name: 'alice', pubkey: 'b'.repeat(64), status: 'active' })
  seedUsername(sqlite, { name: 'cool_dude', pubkey: 'c'.repeat(64), status: 'active' })
  seedUsername(sqlite, { name: 'josé', pubkey: 'd'.repeat(64), status: 'active' })
  return db
}

function lookup(acctUser: string) {
  const resource = encodeURIComponent(`acct:${acctUser}@divine.video`)
  return new Request(`http://localhost/.well-known/webfinger?resource=${resource}`)
}

describe.skipIf(!sqliteAvailable())('WebFinger lookup of an internationalized name', () => {
  // Guard the premise: if validateUsername ever stops producing this canonical
  // form, the test is asserting against the wrong stored value.
  it('stores the punycode form, which is what the row holds', () => {
    expect(validateUsername(DISPLAY).canonical).toBe(CANONICAL)
  })

  // nip05.ts canonicalizes before looking up; webfinger.ts did not, so it
  // compared 'café' against a row holding 'xn--caf-dma' on both columns.
  it('finds the name when the acct carries its display form', async () => {
    const res = await app().fetch(lookup(DISPLAY), { DB: seeded() }, createExecutionContext())

    expect(res.status).toBe(200)
    const jrd = await res.json() as { subject: string }
    expect(jrd.subject).toBe(`acct:${CANONICAL}@divine.video`)
  })

  // Lowercasing the display form gives the handle for an ASCII name but not
  // for this one, so only a Unicode row shows which column the JRD is built from.
  it('builds every JRD field from the punycode handle, not the display form', async () => {
    const res = await app().fetch(lookup(DISPLAY), { DB: seeded() }, createExecutionContext())

    expect(res.status).toBe(200)
    const jrd = await res.json() as { subject: string; aliases: string[]; links: { rel: string; href: string }[] }
    const profileUrl = `https://${CANONICAL}.divine.video`
    const actorUrl = `https://divine.video/ap/users/${CANONICAL}`
    expect(jrd.subject).toBe(`acct:${CANONICAL}@divine.video`)
    expect(jrd.aliases).toEqual([profileUrl, actorUrl])
    expect(jrd.links.find((link) => link.rel === 'http://webfinger.net/rel/profile-page')?.href).toBe(profileUrl)
    expect(jrd.links.find((link) => link.rel === 'self')?.href).toBe(actorUrl)
  })

  it('still finds it when the acct already carries the punycode form', async () => {
    const res = await app().fetch(lookup(CANONICAL), { DB: seeded() }, createExecutionContext())

    expect(res.status).toBe(200)
  })

  it('still finds a plain ASCII name', async () => {
    const res = await app().fetch(lookup('alice'), { DB: seeded() }, createExecutionContext())

    expect(res.status).toBe(200)
  })

  it('still finds an ASCII name typed in mixed case', async () => {
    const res = await app().fetch(lookup('ALICE'), { DB: seeded() }, createExecutionContext())

    expect(res.status).toBe(200)
  })

  it('still finds an active legacy name that current claim rules reject', async () => {
    const res = await app().fetch(lookup('cool_dude'), { DB: seeded() }, createExecutionContext())

    expect(res.status).toBe(200)
  })

  // The raw lookup runs whenever the canonical one misses, not only when the
  // current rules reject the name. `josé` canonicalizes to punycode, so a
  // legacy row holding it as typed is the case that tells those two apart.
  it('still finds a legacy row that holds a Unicode name as typed', async () => {
    const res = await app().fetch(lookup('josé'), { DB: seeded() }, createExecutionContext())

    expect(res.status).toBe(200)
  })

  it('still reports an unknown name as not found', async () => {
    const res = await app().fetch(lookup('nobody'), { DB: seeded() }, createExecutionContext())

    expect(res.status).toBe(404)
  })

  // Canonicalizing means running a validator that throws. A local-part no
  // username could ever have must stay a 404, not become a 500.
  it('reports an unregisterable local-part as not found, not an error', async () => {
    const res = await app().fetch(lookup('bad_name'), { DB: seeded() }, createExecutionContext())

    expect(res.status).toBe(404)
  })
})
