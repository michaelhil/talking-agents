// ============================================================================
// GitHub-tokens admin routes — UI surface for SAMSINN_PACK_REGISTRY_TOKEN /
// SAMSINN_WIKI_REGISTRY_TOKEN equivalents.
//
// GET  /api/github-tokens              { packRegistry: { hasKey, source, maskedKey, envVar }, wikiRegistry: {...} }
// PUT  /api/github-tokens/:slot        body: { apiKey: string | null }
//
// Mirrors /api/providers conventions — never returns plaintext keys, never
// logs them, file mode 0600. Mutations bust the relevant discovery cache so
// the next list call retries with the new auth.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import {
  loadGithubTokens,
  saveGithubTokens,
  mergeWithEnv,
  envVarFor,
  STORE_VERSION,
  type TokenSlot,
} from '../../core/github-tokens.ts'
import { invalidateRegistryCache as invalidatePackCache } from '../../packs/registry.ts'
import { invalidateDiscoveryCache as invalidateWikiCache } from '../../wiki/discovery.ts'

const VALID_SLOTS: ReadonlyArray<TokenSlot> = ['packRegistry', 'wikiRegistry']
const isValidSlot = (s: string): s is TokenSlot => VALID_SLOTS.includes(s as TokenSlot)

const renderState = (merged: ReturnType<typeof mergeWithEnv>) => ({
  packRegistry: {
    hasKey: merged.packRegistry.apiKey.length > 0,
    source: merged.packRegistry.source,
    maskedKey: merged.packRegistry.maskedKey,
    envVar: envVarFor('packRegistry'),
  },
  wikiRegistry: {
    hasKey: merged.wikiRegistry.apiKey.length > 0,
    source: merged.wikiRegistry.source,
    maskedKey: merged.wikiRegistry.maskedKey,
    envVar: envVarFor('wikiRegistry'),
  },
})

export const githubTokensRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/github-tokens$/,
    handler: async (_req, _match, { system }) => {
      const merged = mergeWithEnv(await loadGithubTokens(system.githubTokensStorePath))
      return json(renderState(merged))
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/github-tokens\/([^/]+)$/,
    handler: async (req, match, { system, broadcast }) => {
      const slot = decodeURIComponent(match[1] ?? '')
      if (!isValidSlot(slot)) return errorResponse(`unknown slot: ${slot}`, 404)
      const body = await parseBody(req) as { apiKey?: unknown }
      if (!('apiKey' in body)) return errorResponse('apiKey is required (string or null)', 400)

      let nextKey: string | undefined
      if (body.apiKey === null) {
        nextKey = undefined
      } else if (typeof body.apiKey === 'string') {
        const trimmed = body.apiKey.trim()
        nextKey = trimmed.length > 0 ? trimmed : undefined
      } else {
        return errorResponse('apiKey must be a string or null', 400)
      }

      const current = await loadGithubTokens(system.githubTokensStorePath)
      const tokens = { ...current.tokens }
      if (nextKey === undefined) delete tokens[slot]
      else tokens[slot] = { apiKey: nextKey }
      await saveGithubTokens(system.githubTokensStorePath, { version: STORE_VERSION, tokens })

      // Invalidate the discovery cache for the affected domain so the next
      // /api/packs/registry or /api/wikis/available call retries authenticated.
      if (slot === 'packRegistry') invalidatePackCache()
      else invalidateWikiCache()

      try { broadcast({ type: 'github_tokens_changed', slot }) } catch { /* ignore */ }

      const merged = mergeWithEnv(await loadGithubTokens(system.githubTokensStorePath))
      return json(renderState(merged))
    },
  },
]
