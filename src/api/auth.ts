// ============================================================================
// Shared-token auth for the deploy mode. Disabled when SAMSINN_TOKEN env is
// unset OR empty — preserves the laptop UX. When set, every HTTP request and
// every WS upgrade must present an HttpOnly session cookie issued by
// /api/auth.
//
// Sessions are STATELESS: the cookie value is sha256(SAMSINN_TOKEN). On each
// request we hash the current env token and constant-time compare. This means:
//   - Restarts no longer invalidate sessions (was a real UX bug — every
//     restart bounced every connected client back to the token prompt).
//   - Rotating SAMSINN_TOKEN invalidates every cookie at once — the desired
//     revocation path.
//   - The cookie value never carries the token itself; only proof that the
//     bearer once submitted it.
//   - There is no per-user session record. For a closed-invitation sandbox
//     this is the right trade-off; not appropriate for multi-tenant SaaS.
// ============================================================================

import { createHash } from 'node:crypto'
import { createRateLimiter, type RateLimiter } from './rate-limit.ts'

const SESSION_COOKIE = 'samsinn_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days — cookie lifetime

// Token check is constant-time to keep timing-leak surface tiny.
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

const requiredToken = (): string | null => {
  const raw = process.env.SAMSINN_TOKEN
  if (!raw || raw.length === 0) return null
  return raw
}

const expectedSessionValue = (): string =>
  createHash('sha256').update(requiredToken() ?? '').digest('hex')

export const authEnabled = (): boolean => requiredToken() !== null

export const validateToken = (candidate: string): boolean => {
  const required = requiredToken()
  if (required === null) return true  // dev passthrough
  return constantTimeEqual(candidate, required)
}

export const issueSession = (): string => expectedSessionValue()

export const isValidSession = (id: string | null): boolean => {
  if (!authEnabled()) return true  // dev passthrough
  if (!id) return false
  return constantTimeEqual(id, expectedSessionValue())
}

// Parse a single cookie value out of the Cookie header. Tiny; avoids a dep.
export const parseCookie = (header: string | null, name: string): string | null => {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    if (k !== name) continue
    return part.slice(eq + 1).trim()
  }
  return null
}

// Build a Set-Cookie header value. HttpOnly + Secure + SameSite=Strict.
export const buildSessionCookie = (sessionId: string): string =>
  `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`

export const sessionCookieName = SESSION_COOKIE

// Read session id from a request's Cookie header.
export const sessionFromRequest = (req: Request): string | null =>
  parseCookie(req.headers.get('cookie'), SESSION_COOKIE)

// A1: rate-limit token-validation attempts per IP.
//
// Two entry points use the same limiter:
//   - POST /api/auth                 (UI form submit)
//   - GET /?token=X                  (invitation URL — server.ts handler)
//
// Defaults sized for an alpha sandbox: 20 attempts per 5-minute window
// covers a fat-fingered user retrying a few times across multiple sessions
// while making online brute-force expensive enough that a 32-byte token
// is well out of reach. Override with SAMSINN_AUTH_RATE_LIMIT and
// SAMSINN_AUTH_RATE_WINDOW_MS.
//
// Co-located with auth.ts so both call sites can import without dragging
// in routes/* (avoids a circular dep with server.ts).
let authLimiter: RateLimiter | null = null
export const getAuthLimiter = (): RateLimiter => {
  if (!authLimiter) {
    authLimiter = createRateLimiter({
      windowMs: Number(process.env.SAMSINN_AUTH_RATE_WINDOW_MS) || 300_000, // 5 min
      max: Number(process.env.SAMSINN_AUTH_RATE_LIMIT) || 20,
    })
  }
  return authLimiter
}

// Test seam — clears the limiter between tests so attempts don't leak.
export const __resetAuthLimiter = (): void => { authLimiter = null }
