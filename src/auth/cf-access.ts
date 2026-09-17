// ABOUTME: Verifies a Cloudflare Access JWT so the admin API trusts a verified
// ABOUTME: token, not merely the presence of the header Access injects.

import { createRemoteJWKSet, jwtVerify } from 'jose'

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>

// createRemoteJWKSet keeps fetched keys and its refetch cooldown on the
// returned resolver. Reuse that resolver across requests so authentication
// does not make a live JWKS request every time.
const jwksResolvers = new Map<string, RemoteJwks>()

function getJwksResolver(issuer: string, audience: string): RemoteJwks {
  const cacheKey = `${issuer}\0${audience}`
  let resolver = jwksResolvers.get(cacheKey)
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
    jwksResolvers.set(cacheKey, resolver)
  }
  return resolver
}

export class AccessValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccessValidationError'
  }
}

export interface AccessConfig {
  // Optional so the worker's binding type (where every var is optional) can be
  // passed directly. Absence is handled at runtime as a verification failure.
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
}

interface AccessClaims {
  email?: string
}

/**
 * Verifies a Cloudflare Access assertion and returns the identity it carries.
 *
 * The worker sits behind Access, so a well-formed request already passed it at
 * the edge. This is defense-in-depth: it confirms the token was actually signed
 * by this team's Access, for this application, and has not expired, rather than
 * trusting that the `Cf-Access-Jwt-Assertion` header exists. The email is taken
 * from the verified payload, never from the separate (spoofable) email header.
 *
 * Throws AccessValidationError on any failure. Callers translate that to 401;
 * a verification failure is an auth failure, never a 500.
 */
export async function verifyAccessJwt(
  assertion: string,
  env: AccessConfig,
): Promise<{ email: string }> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    // Missing config is not a server fault to the caller: it must read as "not
    // authenticated" so the request can fall through to the other auth paths,
    // never as a 500.
    throw new AccessValidationError('Access verification is not configured')
  }

  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const issuer = `https://${teamDomain}`

  let verified
  try {
    // Inside the try so a malformed team domain (new URL throwing) is wrapped as
    // an auth failure and falls through, rather than a raw TypeError the callers
    // rethrow as a 500 — which would lock out the Keycast path this promises not
    // to.
    const jwks = getJwksResolver(issuer, env.ACCESS_AUD)
    verified = await jwtVerify<AccessClaims>(assertion, jwks, {
      issuer,
      audience: env.ACCESS_AUD,
      // Access signs RS256. Pinning it means a key of another type appearing in
      // the JWKS cannot change how this token is validated.
      algorithms: ['RS256'],
    })
  } catch (error) {
    throw new AccessValidationError(
      error instanceof Error ? error.message : 'Access token verification failed',
    )
  }

  const email = verified.payload.email
  if (!email) {
    throw new AccessValidationError('Access token has no email claim')
  }

  return { email }
}
