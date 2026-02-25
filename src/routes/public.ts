// ABOUTME: Public-facing routes for names.divine.video
// ABOUTME: Landing page and HTML email confirmation (hostname-guarded)

import { Hono } from 'hono'
import { landingPage } from '../templates/landing'
import { confirmSuccess, confirmAlreadyUsed, confirmExpired, confirmInvalid } from '../templates/confirm-result'
import { getReservationByToken, confirmReservation } from '../db/queries'

type Bindings = {
  DB: D1Database
}

const ALLOWED_HOSTNAMES = ['names.divine.video', 'localhost', '127.0.0.1']

const publicRoutes = new Hono<{ Bindings: Bindings }>()

// Hostname guard: only activate on names.divine.video (and localhost for dev)
publicRoutes.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  const hostname = url.hostname

  // Allow names.divine.video and local dev
  if (!ALLOWED_HOSTNAMES.includes(hostname)) {
    return next()
  }

  // Don't intercept API routes or admin routes
  if (url.pathname.startsWith('/api/')) {
    return next()
  }

  // Don't intercept .well-known
  if (url.pathname.startsWith('/.well-known/')) {
    return next()
  }

  await next()
})

// Landing page
publicRoutes.get('/', async (c) => {
  const url = new URL(c.req.url)
  if (!ALLOWED_HOSTNAMES.includes(url.hostname)) {
    return // Let other routes handle it
  }

  return c.html(landingPage())
})

// Email confirmation — renders HTML result page
publicRoutes.get('/confirm', async (c) => {
  const url = new URL(c.req.url)
  if (!ALLOWED_HOSTNAMES.includes(url.hostname)) {
    return // Let other routes handle it
  }

  const token = c.req.query('token')

  if (!token) {
    return c.html(confirmInvalid(), 400)
  }

  try {
    const reservation = await getReservationByToken(c.env.DB, token)

    if (!reservation) {
      return c.html(confirmInvalid(), 404)
    }

    if (reservation.confirmed_at !== null) {
      return c.html(confirmAlreadyUsed(), 409)
    }

    const now = Math.floor(Date.now() / 1000)
    if (reservation.expires_at < now) {
      return c.html(confirmExpired(), 410)
    }

    // Subscription expires 1 year from confirmation
    const subscriptionExpiresAt = now + (365 * 24 * 60 * 60)

    await confirmReservation(c.env.DB, token, reservation.username_canonical, subscriptionExpiresAt)

    return c.html(confirmSuccess(reservation.username_canonical, subscriptionExpiresAt))
  } catch (error) {
    console.error('Confirm page error:', error)
    return c.html(confirmInvalid(), 500)
  }
})

export default publicRoutes
