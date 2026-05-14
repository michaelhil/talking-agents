// ============================================================================
// Instance cookie — identifies which per-tenant House the request belongs to.
//
// Independent of the existing samsinn_session token cookie:
//   samsinn_session   → "may this client talk to Samsinn at all?" (Strict)
//   samsinn_instance  → "which instance does this client belong to?" (Lax)
//
// SameSite=Lax so a ?join=<id> link from email/Slack still sets the cookie
// on the redirect. Lax is fine — the cookie alone isn't an auth token; the
// instance ID is non-secret (it's shared via ?join links by design).
//
// Secure flag is auto-detected: opt in when the request looks HTTPS-fronted
// (X-Forwarded-Proto: https), or when SAMSINN_SECURE_COOKIES=1 is set.
// In dev (localhost over HTTP), Secure would prevent the cookie from being
// set at all — we don't want that.
// ============================================================================

import { isValidInstanceId } from '../core/paths.ts'
import { parseCookie } from './auth.ts'

export const INSTANCE_COOKIE = 'samsinn_instance'
const TTL_DAYS = 30
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60

// 16 chars from a base32-lowercase alphabet ≈ 80 bits of entropy. More than
// enough collision resistance for an ephemeral instance space.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export const generateInstanceId = (): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

// Read + validate the instance cookie. Returns null if missing or malformed.
export const getInstanceId = (req: Request): string | null => {
  const raw = parseCookie(req.headers.get('cookie'), INSTANCE_COOKIE)
  if (!raw) return null
  if (!isValidInstanceId(raw)) return null
  return raw
}

// Decide if the response should set Secure on the cookie. We use:
//   - X-Forwarded-Proto: https     (Caddy / common reverse proxy)
//   - SAMSINN_SECURE_COOKIES=1     (explicit override for unusual setups)
// Otherwise we omit Secure so dev over plain HTTP works.
const shouldUseSecure = (req: Request): boolean => {
  if (process.env.SAMSINN_SECURE_COOKIES === '1') return true
  const xfp = req.headers.get('x-forwarded-proto')
  if (xfp && xfp.toLowerCase() === 'https') return true
  // Fallback: parse the request URL — for direct (no proxy) HTTPS connections.
  try {
    if (new URL(req.url).protocol === 'https:') return true
  } catch { /* malformed URL — pass through */ }
  return false
}

// Build the Set-Cookie header value for the instance cookie.
export const buildInstanceCookie = (id: string, req: Request): string => {
  const secure = shouldUseSecure(req) ? '; Secure' : ''
  return `${INSTANCE_COOKIE}=${id}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${TTL_SECONDS}`
}

// One-shot read of ?instance=<id> for scripted callers without cookie jars.
// Doesn't set the cookie — the caller passes the param on every request.
// Returns null if param missing or invalid.
export const getInstanceFromQuery = (url: URL): string | null => {
  const raw = url.searchParams.get('instance')
  if (!raw) return null
  if (!isValidInstanceId(raw)) return null
  return raw
}

// Read the ?join=<id> param. Validates format. Used by the redirect handler
// to set a cookie + 303 → / so the user lands on the joined instance.
export const getJoinFromQuery = (url: URL): string | null => {
  const raw = url.searchParams.get('join')
  if (!raw) return null
  if (!isValidInstanceId(raw)) return null
  return raw
}

// Resolve an instance ID for a request — single source of truth.
//   1. ?join=<id>       — caller wants to switch instance (cookie will be set)
//   2. samsinn_instance cookie
//   3. ?instance=<id>   — one-shot for scripted callers
//   4. null              — caller will auto-create
//
// Boundary handlers look at the return + the joinRequested flag to decide
// what to do (redirect for join, create for null, look up for cookie/query).
export interface ResolvedInstance {
  readonly id: string | null
  readonly source: 'join' | 'cookie' | 'query' | 'none'
}

export const resolveInstanceId = (req: Request, url: URL): ResolvedInstance => {
  const joined = getJoinFromQuery(url)
  if (joined) return { id: joined, source: 'join' }
  const cookie = getInstanceId(req)
  if (cookie) return { id: cookie, source: 'cookie' }
  const queried = getInstanceFromQuery(url)
  if (queried) return { id: queried, source: 'query' }
  return { id: null, source: 'none' }
}

// Resolve OR mint an instance id and decide whether the response needs to
// set a fresh cookie. This is the policy `server.ts` ran inline before; it
// lives here so the mint-vs-reuse decision can be unit-tested alongside the
// other instance-cookie helpers without spinning up a server.
//   - When `resolveInstanceId` returns an id (join / cookie / query), reuse
//     it and DON'T issue a Set-Cookie (cookie source already has it, or the
//     join/query handlers higher up have their own Set-Cookie response).
//   - When nothing identifies the visitor, mint a fresh id and produce the
//     Set-Cookie value so the next request lands on the same instance.
export interface MintedInstance {
  readonly instanceId: string
  readonly setCookieValue: string | null
  readonly isNew: boolean
}
export const resolveOrMintInstance = (req: Request, url: URL): MintedInstance => {
  const resolved = resolveInstanceId(req, url)
  if (resolved.id !== null) {
    return { instanceId: resolved.id, setCookieValue: null, isNew: false }
  }
  const fresh = generateInstanceId()
  return {
    instanceId: fresh,
    setCookieValue: buildInstanceCookie(fresh, req),
    isNew: true,
  }
}

// WS session-token reuse guard: refuse upgrade when an existing session
// under the same token is bound to a different instance (browser swapped
// cookies on us). Returns true ⇒ caller must 403.
export const isSessionBoundToOtherInstance = (
  existing: { instanceId: string } | undefined,
  instanceId: string,
): boolean => existing !== undefined && existing.instanceId !== instanceId
