// ABOUTME: Provides fail-closed bearer-token authentication for internal service routes.
// ABOUTME: Keeps service credentials least-privileged by selecting a route-specific binding.

import type { MiddlewareHandler } from 'hono'

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  let difference = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  for (let i = 0; i < length; i += 1) {
    difference |= (leftBytes[i] || 0) ^ (rightBytes[i] || 0)
  }
  return difference === 0
}

export function requireServiceToken(
  binding: string,
  serviceLabel: string
): MiddlewareHandler<{ Bindings: Record<string, unknown> }> {
  return async (c, next) => {
    const configured = c.env[binding]
    if (typeof configured !== 'string' || configured.length === 0) {
      return c.json({ ok: false, error: `${serviceLabel} token is not configured` }, 503)
    }

    const auth = c.req.header('Authorization') || ''
    if (!auth.startsWith('Bearer ') || !constantTimeEqual(auth.slice('Bearer '.length), configured)) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401)
    }
    await next()
  }
}
