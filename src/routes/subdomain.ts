// ABOUTME: Subdomain profile routing middleware
// ABOUTME: Serves SPA at username.divine.video with injected user data for client-side routing

import { Hono } from 'hono'
import { getUsernameByName } from '../db/queries'
import { bech32 } from '@scure/base'
import { getSubdomain } from '../utils/subdomain'

type Bindings = {
  DB: D1Database
}

const subdomain = new Hono<{ Bindings: Bindings }>()

function hexToNpub(hex: string): string {
  // Validate hex string length
  if (hex.length !== 64) {
    throw new Error(`Invalid hex string length: expected 64 characters, got ${hex.length}`)
  }

  // Validate hex string contains only valid hex characters
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Invalid hex string: contains non-hexadecimal characters')
  }

  const data = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    data[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  const words = bech32.toWords(data)
  return bech32.encode('npub', words)
}

// Static asset extensions to pass through to origin
const ASSET_EXTENSIONS = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.json', '.webmanifest', '.map']

subdomain.get('*', async (c) => {
  const url = new URL(c.req.url)
  const hostname = url.hostname
  const subdomainName = getSubdomain(hostname)

  if (!subdomainName) {
    // Not a subdomain, pass through
    return c.notFound()
  }

  // Check if this is a static asset request - proxy to main app
  const isAsset = ASSET_EXTENSIONS.some(ext => url.pathname.endsWith(ext)) || url.pathname.startsWith('/assets/')
  if (isAsset) {
    const mainAppUrl = `https://divine.video${url.pathname}${url.search}`
    const response = await fetch(mainAppUrl)
    return new Response(response.body, {
      status: response.status,
      headers: response.headers
    })
  }

  try {
    // Look up username (normalize to lowercase for canonical lookup)
    const canonicalSubdomain = subdomainName.toLowerCase()
    const username = await getUsernameByName(c.env.DB, canonicalSubdomain)

    if (!username || username.status !== 'active' || !username.pubkey) {
      return c.html(`
        <html>
          <head><title>User Not Found</title></head>
          <body>
            <h1>Username @${subdomainName}.divine.video not found</h1>
            <p>This username is not currently active.</p>
          </body>
        </html>
      `, 404)
    }

    // Convert pubkey to npub
    const npub = hexToNpub(username.pubkey)

    // Fetch profile from Funnelcake for display_name, picture, about
    let profileData: { name?: string; display_name?: string; picture?: string; about?: string } = {}
    try {
      const profileResponse = await fetch(`https://relay.divine.video/api/users/${username.pubkey}`)
      if (profileResponse.ok) {
        const data = await profileResponse.json() as { profile?: typeof profileData }
        profileData = data.profile || {}
      }
    } catch (e) {
      console.error('Failed to fetch profile from Funnelcake:', e)
    }

    // Fetch the index.html from main app (not the profile page - we want the SPA shell)
    const mainAppUrl = 'https://divine.video/'
    const response = await fetch(mainAppUrl)

    if (!response.ok) {
      console.error('Failed to fetch main app:', response.status)
      return c.html('<h1>Error loading profile</h1>', 500)
    }

    let html = await response.text()

    // Use display name from username_display field or profile
    const displayName = username.username_display || profileData.display_name || profileData.name || subdomainName

    // Build user data object to inject
    const userData = {
      subdomain: subdomainName,
      pubkey: username.pubkey,
      npub: npub,
      username: username.username_display || username.name || subdomainName,
      displayName: displayName,
      picture: profileData.picture || null,
      about: profileData.about || null,
      nip05: `${subdomainName}@divine.video`,
    }

    // Inject user data script before </head>
    const userDataScript = `<script>window.__DIVINE_USER__ = ${JSON.stringify(userData)};</script>`
    html = html.replace('</head>', `${userDataScript}</head>`)

    // Update OG meta tags for better sharing
    const ogTitle = userData.displayName
    const ogDescription = userData.about || `Watch ${userData.displayName}'s videos on diVine`
    const ogImage = userData.picture || 'https://divine.video/og-image.png'
    const ogUrl = `https://${subdomainName}.divine.video`

    // Replace existing OG tags or add them
    html = html.replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${escapeHtml(ogTitle)}">`)
    html = html.replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${escapeHtml(ogDescription)}">`)
    html = html.replace(/<meta property="og:image"[^>]*>/, `<meta property="og:image" content="${ogImage}">`)
    html = html.replace(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${ogUrl}">`)

    // Also update Twitter card tags
    html = html.replace(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${escapeHtml(ogTitle)}">`)
    html = html.replace(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${escapeHtml(ogDescription)}">`)
    html = html.replace(/<meta name="twitter:image"[^>]*>/, `<meta name="twitter:image" content="${ogImage}">`)

    // Update page title
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(ogTitle)} | diVine</title>`)

    return c.html(html)

  } catch (error) {
    console.error('Subdomain routing error:', error)
    return c.html('<h1>Error loading profile</h1>', 500)
  }
})

// Helper to escape HTML special characters
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export default subdomain
