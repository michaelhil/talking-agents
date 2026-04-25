// ============================================================================
// Bug reporting — POST /api/bugs creates a GitHub issue on the configured
// repo using a server-side PAT. The browser never sees the token.
//
// Config via env (set in /etc/samsinn/env on production):
//   SAMSINN_GH_TOKEN  — fine-grained PAT with Issues: Read+Write on the repo
//   SAMSINN_GH_REPO   — "owner/repo" (defaults to michaelhil/samsinn)
//
// If SAMSINN_GH_TOKEN is unset the route returns 503 — the UI surfaces it
// as "bug reporting not configured on this server."
//
// Rate-limited via the shared per-IP limiter from routes/instances.ts (the
// answer to the design question was "share the limiter" — one map, two
// consumers).
//
// Auto-context attached to every issue: app version + browser UA, sourced
// from the request body (the UI fills these from /api/system/info +
// navigator.userAgent). Never includes room names, agent names, messages,
// or logs — those would leak user content to a public repo.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { createSharedLimiter } from './instances.ts'

const REPO = process.env.SAMSINN_GH_REPO ?? 'michaelhil/samsinn'
const TOKEN = process.env.SAMSINN_GH_TOKEN ?? ''

// Boot log — once at module load, never logs the token itself.
if (TOKEN) {
  console.log(`[bugs] reporting enabled (repo=${REPO})`)
} else {
  console.log('[bugs] reporting disabled (set SAMSINN_GH_TOKEN to enable)')
}

const MAX_TITLE = 200
const MAX_DESC = 8000

const buildIssueBody = (description: string, version: string, userAgent: string): string => {
  const ua = userAgent.length > 500 ? userAgent.slice(0, 500) + '…' : userAgent
  return [
    '*Reported via samsinn UI*',
    '',
    description.trim(),
    '',
    '---',
    `samsinn version: \`${version || 'unknown'}\``,
    `user agent: \`${ua || 'unknown'}\``,
  ].join('\n')
}

export const bugRoutes: RouteEntry[] = [
  {
    method: 'POST',
    pattern: /^\/api\/bugs$/,
    handler: async (req, _match, ctx) => {
      if (!TOKEN) return errorResponse('bug reporting not configured', 503)

      const limit = createSharedLimiter.check(ctx.remoteAddress)
      if (!limit.ok) {
        const retryS = Math.ceil(limit.retryAfterMs / 1000)
        return new Response(
          JSON.stringify({ error: `rate limit — try again in ${retryS}s` }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryS) },
          },
        )
      }

      const body = await parseBody(req)
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const description = typeof body.description === 'string' ? body.description.trim() : ''
      if (!title) return errorResponse('title is required', 400)
      if (title.length > MAX_TITLE) return errorResponse(`title too long (max ${MAX_TITLE})`, 400)
      if (!description) return errorResponse('description is required', 400)
      if (description.length > MAX_DESC) return errorResponse(`description too long (max ${MAX_DESC})`, 400)

      const version = typeof body.version === 'string' ? body.version : ''
      const userAgent = typeof body.userAgent === 'string' ? body.userAgent : ''

      const issueBody = buildIssueBody(description, version, userAgent)
      let res: Response
      try {
        res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'samsinn-bug-reporter',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, body: issueBody }),
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(`[bugs] network error: ${reason}`)
        return errorResponse('bug submission failed (network)', 502)
      }

      if (res.ok) {
        const issue = await res.json().catch(() => ({})) as { html_url?: string; number?: number }
        return json({ ok: true, htmlUrl: issue.html_url, number: issue.number }, 201)
      }

      // Discriminate failure modes so the UI can show actionable messages.
      if (res.status === 401) {
        console.error('[bugs] GitHub auth failed (check SAMSINN_GH_TOKEN)')
        return errorResponse('bug reporting auth failed — contact admin', 502)
      }
      if (res.status === 403) {
        const retryAfter = res.headers.get('retry-after')
        const r = retryAfter ? new Response(
          JSON.stringify({ error: 'GitHub rate-limited — try again later' }),
          { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': retryAfter } },
        ) : errorResponse('GitHub rate-limited — try again later', 503)
        return r
      }
      if (res.status === 422) {
        const detail = await res.json().catch(() => ({})) as { message?: string }
        return errorResponse(`validation: ${detail.message ?? 'unknown'}`, 400)
      }
      const detail = await res.text().catch(() => '')
      console.error(`[bugs] GitHub ${res.status}: ${detail.slice(0, 200)}`)
      return errorResponse(`bug submission failed (${res.status})`, 502)
    },
  },
]
