// ABOUTME: ActivityPub discovery endpoints — WebFinger (JRD) + NodeInfo
// ABOUTME: Read-only projection over the usernames table; makes @user@divine.video resolvable + Divine counted on the fediverse

import { Hono } from 'hono'
import { getUsernameByName, countActiveUsernames } from '../db/queries'

type Bindings = {
  DB: D1Database
  // Base URL for the ActivityPub gateway actor (Workstream C). The rel=self
  // href becomes `${AP_ACTOR_BASE_URL}{user}`. Default keeps webfinger working
  // before the gateway env is wired up.
  AP_ACTOR_BASE_URL?: string
}

const DEFAULT_AP_ACTOR_BASE_URL = 'https://divine.video/ap/users/'

// Software version reported by NodeInfo (kept in sync with the worker's service version).
const SOFTWARE_VERSION = '0.1.0'

const webfinger = new Hono<{ Bindings: Bindings }>()

// GET /.well-known/webfinger?resource=acct:{user}@divine.video → JRD
webfinger.get('/.well-known/webfinger', async (c) => {
  try {
    const resource = c.req.query('resource')

    if (!resource) {
      return c.json({ error: 'resource is required.' }, 400, {
        'Access-Control-Allow-Origin': '*'
      })
    }

    // Parse `acct:{user}@{domain}` and reject acct domains this service does not own.
    const acct = resource.startsWith('acct:') ? resource.slice('acct:'.length) : resource
    const atIndex = acct.lastIndexOf('@')
    const user = atIndex === -1 ? acct : acct.slice(0, atIndex)
    const domain = atIndex === -1 ? null : acct.slice(atIndex + 1).toLowerCase()

    if (!user || (domain !== null && domain !== 'divine.video')) {
      return c.notFound()
    }

    const username = await getUsernameByName(c.env.DB, user)

    if (!username || username.status !== 'active') {
      return c.notFound()
    }

    // Use the canonical (lowercase) form everywhere so subject/aliases/links are
    // internally consistent and match DNS-lowercase subdomain URLs.
    const handle = username.username_canonical || username.name

    const actorBase = c.env.AP_ACTOR_BASE_URL || DEFAULT_AP_ACTOR_BASE_URL
    const actorUrl = `${actorBase.replace(/\/$/, '')}/${handle}`
    const profileUrl = `https://${handle}.divine.video`

    const jrd = {
      subject: `acct:${handle}@divine.video`,
      aliases: [profileUrl, actorUrl],
      links: [
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: profileUrl
        },
        {
          rel: 'self',
          type: 'application/activity+json',
          href: actorUrl
        }
      ]
    }

    c.header('Content-Type', 'application/jrd+json')
    c.header('Cache-Control', 'public, max-age=60')
    c.header('Access-Control-Allow-Origin', '*')
    return c.body(JSON.stringify(jrd))
  } catch (error) {
    console.error('WebFinger error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /.well-known/nodeinfo → discovery document pointing at the 2.1 doc
webfinger.get('/.well-known/nodeinfo', async (c) => {
  return c.json(
    {
      links: [
        {
          rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
          href: 'https://divine.video/nodeinfo/2.1'
        }
      ]
    },
    200,
    {
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*'
    }
  )
})

// GET /nodeinfo/2.1 → NodeInfo 2.1 document
webfinger.get('/nodeinfo/2.1', async (c) => {
  try {
    const total = await countActiveUsernames(c.env.DB)

    return c.json(
      {
        version: '2.1',
        software: {
          name: 'divine',
          version: SOFTWARE_VERSION
        },
        protocols: ['activitypub'],
        services: {
          inbound: [],
          outbound: []
        },
        openRegistrations: false,
        usage: {
          users: {
            total
          },
          localPosts: 0
        },
        metadata: {}
      },
      200,
      {
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*'
      }
    )
  } catch (error) {
    console.error('NodeInfo error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default webfinger
