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
// Rate-limited via a dedicated per-IP limiter (10/hour by default) — see
// getBugLimiter below. Not shared with instance-create: bug submissions
// are rarer for legitimate users and the abuse path (spam to the
// operator's public GitHub repo) needs a tighter cap than instance
// creation does.
//
// Auto-context attached to every issue: app version + browser UA, sourced
// from the request body (the UI fills these from /api/system/info +
// navigator.userAgent). Never includes room names, agent names, messages,
// or logs — those would leak user content to a public repo.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { createRateLimiter, type RateLimiter } from '../rate-limit.ts'

const REPO = process.env.SAMSINN_GH_REPO ?? 'michaelhil/samsinn'
const TOKEN = process.env.SAMSINN_GH_TOKEN ?? ''

// A3: dedicated rate limiter, NOT shared with instance-create. Tighter
// window — bug submissions are rare for legitimate users (10/hour is
// generous; a frustrated user retrying still goes through), and the
// abuse path (an authenticated tester spamming the operator's GitHub
// repo) is meaningfully expensive to defend against later. Override
// via SAMSINN_BUG_RATE_LIMIT and SAMSINN_BUG_RATE_WINDOW_MS.
let bugLimiter: RateLimiter | null = null
const getBugLimiter = (): RateLimiter => {
  if (!bugLimiter) {
    bugLimiter = createRateLimiter({
      windowMs: Number(process.env.SAMSINN_BUG_RATE_WINDOW_MS) || 3_600_000, // 1 hour
      max: Number(process.env.SAMSINN_BUG_RATE_LIMIT) || 10,
    })
  }
  return bugLimiter
}

// Boot log — once at module load, never logs the token itself.
if (TOKEN) {
  console.log(`[bugs] reporting enabled (repo=${REPO})`)
} else {
  console.log('[bugs] reporting disabled (set SAMSINN_GH_TOKEN to enable)')
}

const MAX_TITLE = 200
const MAX_DESC = 8000

// A5: wrap user description in a 4-tilde fenced code block so GitHub
// doesn't render any markdown features inside it. Eliminates @user
// mentions (which would ping unrelated GitHub users from the operator's
// repo), #123 issue cross-references, image hotlinks, and any future
// GitHub markdown features. Cost: the description renders as plain text
// — fine for bug reports, where the operator reads it as content not
// markup.
//
// 4-tilde fence is used so a description containing the more common
// ``` triple-backticks doesn't close the wrapper early. To defend
// against deliberate fence-escape via embedded ~~~~+ in input, replace
// any 4+ tildes in the user content with 3 tildes before wrapping.
const wrapAsCodeBlock = (s: string): string => {
  const safe = s.replace(/~~~~+/g, '~~~')
  return `~~~~\n${safe}\n~~~~`
}

// Exported for test seam — buildIssueBody returns the GitHub markdown body
// string that gets POSTed; unit tests assert the wrap + escape behaviour.
export const buildIssueBody = (description: string, version: string, userAgent: string): string => {
  const ua = userAgent.length > 500 ? userAgent.slice(0, 500) + '…' : userAgent
  return [
    '*Reported via samsinn UI*',
    '',
    wrapAsCodeBlock(description.trim()),
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

      const limit = getBugLimiter().check(ctx.remoteAddress)
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
      // A4: 15s abort. A slow / hung GitHub response otherwise leaves the
      // connection open indefinitely — bad for UX (UI spinner) and for the
      // server's outbound socket pool. AbortError lands in the catch below
      // alongside DNS / connection-refused / etc., which already maps to
      // the "network failure" UI path. No separate branch needed.
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15_000)
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
          signal: controller.signal,
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(`[bugs] network error: ${reason}`)
        return errorResponse('bug submission failed (network)', 502)
      } finally {
        clearTimeout(timeoutId)
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
