// ============================================================================
// Discovery sources admin routes — UI-managed list of GitHub <owner> /
// <owner>/<repo> strings that pack and wiki discovery scan.
//
// GET  /api/discovery-sources          { packs: [...], wikis: [...], envPacks: [...], envWikis: [...] }
// PUT  /api/discovery-sources          body: { packs?, wikis? } — replaces the listed domains
//
// envPacks / envWikis report what's coming from SAMSINN_PACK_SOURCES /
// SAMSINN_WIKI_SOURCES so the UI can show "from env (read-only)" alongside
// editable stored entries. Mutations clear the relevant in-memory discovery
// cache so the next list call refetches with the new sources.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import {
  loadDiscoverySources,
  saveDiscoverySources,
  STORE_VERSION,
} from '../../core/discovery-sources.ts'
import { invalidateRegistryCache as invalidatePackCache } from '../../packs/registry.ts'
import { invalidateDiscoveryCache as invalidateWikiCache } from '../../wiki/discovery.ts'

const splitEnv = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)

const validateList = (raw: unknown): { ok: true; value: ReadonlyArray<string> } | { ok: false; error: string } => {
  if (!Array.isArray(raw)) return { ok: false, error: 'must be an array' }
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw as unknown[]) {
    if (typeof v !== 'string') return { ok: false, error: 'all entries must be strings' }
    const trimmed = v.trim()
    if (trimmed.length === 0) continue
    // Allow `<owner>` or `<owner>/<repo>`. GitHub usernames/orgs: alphanumeric
    // and single hyphens; repos: alphanumeric, ., _, -.
    if (!/^[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/.test(trimmed)) {
      return { ok: false, error: `"${trimmed}" — expected "owner" or "owner/repo"` }
    }
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return { ok: true, value: out }
}

export const discoverySourcesRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/discovery-sources$/,
    handler: async (_req, _match, { system }) => {
      const data = await loadDiscoverySources(system.discoverySourcesStorePath)
      return json({
        packs: data.packs,
        wikis: data.wikis,
        envPacks: splitEnv(process.env.SAMSINN_PACK_SOURCES),
        envWikis: splitEnv(process.env.SAMSINN_WIKI_SOURCES),
      })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/discovery-sources$/,
    handler: async (req, _match, { system, broadcast }) => {
      const body = await parseBody(req) as { packs?: unknown; wikis?: unknown }
      const current = await loadDiscoverySources(system.discoverySourcesStorePath)
      let nextPacks = current.packs
      let nextWikis = current.wikis
      if ('packs' in body) {
        const v = validateList(body.packs)
        if (!v.ok) return errorResponse(`packs: ${v.error}`, 400)
        nextPacks = v.value
      }
      if ('wikis' in body) {
        const v = validateList(body.wikis)
        if (!v.ok) return errorResponse(`wikis: ${v.error}`, 400)
        nextWikis = v.value
      }
      await saveDiscoverySources(system.discoverySourcesStorePath, {
        version: STORE_VERSION,
        packs: nextPacks,
        wikis: nextWikis,
      })
      // Bust both caches so the next list call refetches against the new sources.
      // Cheap: each cache is a single Promise/array reference.
      invalidatePackCache()
      invalidateWikiCache()
      try { broadcast({ type: 'discovery_sources_changed' }) } catch { /* ignore */ }
      return json({
        packs: nextPacks,
        wikis: nextWikis,
        envPacks: splitEnv(process.env.SAMSINN_PACK_SOURCES),
        envWikis: splitEnv(process.env.SAMSINN_WIKI_SOURCES),
      })
    },
  },
]
