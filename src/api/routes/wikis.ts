// ============================================================================
// Wikis admin routes — register/edit/delete wiki configs, refresh cache,
// bind/unbind wikis to rooms or agents.
//
// GET    /api/wikis                            list configured wikis (masked PAT, last-warm, page count)
// POST   /api/wikis                            register a wiki  body: { id, owner, repo, ref?, displayName?, apiKey?, enabled? }
// PUT    /api/wikis/:id                        edit              body: any subset
// DELETE /api/wikis/:id                        unregister
// POST   /api/wikis/:id/refresh                trigger warm; returns { pageCount, warnings }
// GET    /api/rooms/:name/wikis                list bindings on a room
// PUT    /api/rooms/:name/wikis                replace bindings  body: { wikiIds: string[] }
//
// Mutations save wikis.json atomically (mode 0600), update the in-memory
// registry, and broadcast `wiki_changed` so panels refresh.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { loadWikiStore, saveWikiStore, isValidWikiId, STORE_VERSION } from '../../wiki/store.ts'
import { asAIAgent } from '../../agents/shared.ts'
import type { WikiConfig } from '../../wiki/types.ts'
import { getAvailableWikis, invalidateDiscoveryCache } from '../../wiki/discovery.ts'
import { resolveActiveWikis } from '../../wiki/resolve-active.ts'

interface WikiPatchBody {
  readonly owner?: string
  readonly repo?: string
  readonly ref?: string
  readonly displayName?: string
  readonly apiKey?: string
  readonly enabled?: boolean
}

interface WikiCreateBody extends WikiPatchBody {
  readonly id?: string
}

const stringOr = (v: unknown, fallback?: string): string | undefined => {
  if (typeof v === 'string') return v
  return fallback
}

export const wikisRoutes: RouteEntry[] = [
  // --- List ---
  {
    method: 'GET',
    pattern: /^\/api\/wikis$/,
    handler: async (_req, _match, { system }) => {
      // Single source of truth: resolveActiveWikis loads the file store,
      // calls discovery, merges, and reconciles the registry. Auto-warm
      // for new ids fires from inside the registry's onNewWiki hook.
      const { warnings } = await loadWikiStore(system.wikisStorePath)
      const merged = await resolveActiveWikis(system.wikisStorePath, system.wikiRegistry)
      const live = system.wikiRegistry.list()
      const liveById = new Map(live.map((w) => [w.id, w]))
      const wikis = merged.map((w) => ({
        id: w.id,
        owner: w.owner,
        repo: w.repo,
        ref: w.ref,
        displayName: w.displayName,
        keyMask: w.maskedKey,
        hasKey: w.apiKey.length > 0,
        enabled: w.enabled,
        source: w.source,
        pageCount: liveById.get(w.id)?.pageCount ?? 0,
        lastWarmAt: liveById.get(w.id)?.lastWarmAt ?? null,
        lastError: liveById.get(w.id)?.lastError ?? null,
      }))
      return json({ wikis, warnings })
    },
  },

  // --- Discovery: list available wikis from SAMSINN_WIKI_SOURCES ---
  // Separate endpoint so the UI Browse tab can show what's discoverable
  // independently of what's in the merged active set. `installed` is true
  // for ids already present in wikis.json (so we don't repeat the row).
  {
    method: 'GET',
    pattern: /^\/api\/wikis\/available$/,
    handler: async (_req, _match, { system }) => {
      let discovered: Awaited<ReturnType<typeof getAvailableWikis>> = []
      try { discovered = await getAvailableWikis() } catch (err) {
        return errorResponse(`discovery failed: ${err instanceof Error ? err.message : String(err)}`, 502)
      }
      const { data: store } = await loadWikiStore(system.wikisStorePath)
      const storedIds = new Set(store.wikis.map((w) => w.id))
      return json({
        wikis: discovered.map((d) => ({
          id: d.id,
          owner: d.owner,
          repo: d.repo,
          displayName: d.displayName,
          description: d.description,
          repoUrl: d.repoUrl,
          installed: storedIds.has(d.id),
        })),
        sources: (process.env.SAMSINN_WIKI_SOURCES ?? 'samsinn-wikis').split(',').map((s) => s.trim()).filter(Boolean),
      })
    },
  },

  // --- Create ---
  {
    method: 'POST',
    pattern: /^\/api\/wikis$/,
    handler: async (req, _match, { system, broadcast }) => {
      const body = await parseBody(req) as WikiCreateBody | null
      if (!body) return errorResponse('invalid body', 400)
      const id = stringOr(body.id)?.trim() ?? ''
      const owner = stringOr(body.owner)?.trim() ?? ''
      const repo = stringOr(body.repo)?.trim() ?? ''
      if (!id || !owner || !repo) return errorResponse('id, owner, repo are required', 400)
      if (!isValidWikiId(id)) return errorResponse(`id must match [a-z0-9][a-z0-9-]*`, 400)

      const { data: store } = await loadWikiStore(system.wikisStorePath)
      if (store.wikis.some((w) => w.id === id)) return errorResponse(`wiki "${id}" already exists`, 409)

      const entry: WikiConfig = {
        id, owner, repo,
        ...(stringOr(body.ref) ? { ref: stringOr(body.ref) as string } : {}),
        ...(stringOr(body.displayName) ? { displayName: stringOr(body.displayName) as string } : {}),
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      }
      const next = { version: STORE_VERSION, wikis: [...store.wikis, entry] }
      await saveWikiStore(system.wikisStorePath, next)
      // Reconcile through the canonical helper so all callers stay in sync.
      await resolveActiveWikis(system.wikisStorePath, system.wikiRegistry)

      // Background warm — don't block the response.
      if (entry.enabled !== false) {
        system.wikiRegistry.warm(id)
          .then(({ pageCount }) => {
            try { broadcast({ type: 'wiki_changed', wikiId: id, action: 'warmed', pageCount }) } catch { /* ignore */ }
          })
          .catch((err) => {
            try { broadcast({ type: 'wiki_changed', wikiId: id, action: 'warm_failed', error: (err as Error).message }) } catch { /* ignore */ }
          })
      }
      try { broadcast({ type: 'wiki_changed', wikiId: id, action: 'created' }) } catch { /* ignore */ }
      return json({ ok: true, id }, 201)
    },
  },

  // --- Edit ---
  {
    method: 'PUT',
    pattern: /^\/api\/wikis\/([^/]+)$/,
    handler: async (req, match, { system, broadcast }) => {
      const id = match[1]!
      const body = await parseBody(req) as WikiPatchBody | null
      if (!body) return errorResponse('invalid body', 400)
      const { data: store } = await loadWikiStore(system.wikisStorePath)
      const idx = store.wikis.findIndex((w) => w.id === id)
      if (idx < 0) return errorResponse(`wiki "${id}" not found`, 404)
      const existing = store.wikis[idx]!
      const updated: WikiConfig = {
        id: existing.id,
        owner: stringOr(body.owner, existing.owner)!,
        repo: stringOr(body.repo, existing.repo)!,
        ...(stringOr(body.ref, existing.ref) ? { ref: stringOr(body.ref, existing.ref) as string } : {}),
        ...(stringOr(body.displayName, existing.displayName) ? { displayName: stringOr(body.displayName, existing.displayName) as string } : {}),
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : (existing.apiKey !== undefined ? { apiKey: existing.apiKey } : {})),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : (existing.enabled !== undefined ? { enabled: existing.enabled } : {})),
      }
      const next = { version: STORE_VERSION, wikis: [...store.wikis.slice(0, idx), updated, ...store.wikis.slice(idx + 1)] }
      await saveWikiStore(system.wikisStorePath, next)
      // Reconcile through the canonical helper so all callers stay in sync.
      await resolveActiveWikis(system.wikisStorePath, system.wikiRegistry)
      try { broadcast({ type: 'wiki_changed', wikiId: id, action: 'updated' }) } catch { /* ignore */ }
      return json({ ok: true })
    },
  },

  // --- Delete ---
  {
    method: 'DELETE',
    pattern: /^\/api\/wikis\/([^/]+)$/,
    handler: async (_req, match, { system, broadcast }) => {
      const id = match[1]!
      const { data: store } = await loadWikiStore(system.wikisStorePath)
      const next = { version: STORE_VERSION, wikis: store.wikis.filter((w) => w.id !== id) }
      if (next.wikis.length === store.wikis.length) return errorResponse(`wiki "${id}" not found`, 404)
      await saveWikiStore(system.wikisStorePath, next)
      // Reconcile via the canonical helper. Delete-of-stored-override-of-
      // discovered leaves the discovered entry active automatically because
      // mergeWithDiscovery still includes it.
      await resolveActiveWikis(system.wikisStorePath, system.wikiRegistry)
      // Also clear bindings from any room.
      for (const profile of system.house.listAllRooms()) {
        const room = system.house.getRoom(profile.id)
        if (!room) continue
        const before = room.getWikiBindings()
        if (before.includes(id)) room.setWikiBindings(before.filter((b) => b !== id))
      }
      try { broadcast({ type: 'wiki_changed', wikiId: id, action: 'deleted' }) } catch { /* ignore */ }
      return json({ ok: true })
    },
  },

  // --- Discovery force-refresh ---
  // Must come BEFORE the per-id refresh below (otherwise the [^/]+ pattern
  // captures "discovery" as the wiki id and 404s). Bust the in-memory
  // discovery cache and re-reconcile. Useful when the operator just
  // transferred a repo into the SAMSINN_WIKI_SOURCES org and doesn't want
  // to wait up to 5 min for the cache to expire.
  {
    method: 'POST',
    pattern: /^\/api\/wikis\/discovery\/refresh$/,
    handler: async (_req, _match, { system, broadcast }) => {
      invalidateDiscoveryCache()
      const merged = await resolveActiveWikis(system.wikisStorePath, system.wikiRegistry)
      try { broadcast({ type: 'wiki_changed', action: 'discovery_refreshed' as const }) } catch { /* ignore */ }
      return json({ ok: true, count: merged.filter((w) => w.enabled).length })
    },
  },

  // --- Refresh (force warm) ---
  {
    method: 'POST',
    pattern: /^\/api\/wikis\/([^/]+)\/refresh$/,
    handler: async (_req, match, { system, broadcast }) => {
      const id = match[1]!
      // resolveActiveWikis reconciles before we look up. Discovered-late
      // wikis become warmable here without operator intervention.
      const merged = await resolveActiveWikis(system.wikisStorePath, system.wikiRegistry)
      if (!merged.some((w) => w.id === id && w.enabled)) {
        return errorResponse(`wiki "${id}" not found`, 404)
      }
      try {
        const result = await system.wikiRegistry.warm(id)
        try { broadcast({ type: 'wiki_changed', wikiId: id, action: 'warmed', pageCount: result.pageCount }) } catch { /* ignore */ }
        return json({ ok: true, pageCount: result.pageCount, warnings: result.warnings })
      } catch (err) {
        return errorResponse(`refresh failed: ${(err as Error).message}`, 502)
      }
    },
  },

  // --- Room bindings: list ---
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/wikis$/,
    handler: async (_req, match, { system }) => {
      const room = system.house.getRoom(decodeURIComponent(match[1]!))
      if (!room) return errorResponse('room not found', 404)
      return json({ wikiIds: room.getWikiBindings() })
    },
  },

  // --- Room bindings: replace ---
  {
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/wikis$/,
    handler: async (req, match, { system, broadcast }) => {
      const room = system.house.getRoom(decodeURIComponent(match[1]!))
      if (!room) return errorResponse('room not found', 404)
      const body = await parseBody(req) as { wikiIds?: ReadonlyArray<unknown> } | null
      const ids = Array.isArray(body?.wikiIds)
        ? (body!.wikiIds as unknown[]).filter((v): v is string => typeof v === 'string')
        : []
      // Validate against the current active set (reconciles in passing).
      const merged = await resolveActiveWikis(system.wikisStorePath, system.wikiRegistry)
      const activeIds = new Set(merged.filter((w) => w.enabled).map((w) => w.id))
      const unknown = ids.filter((id) => !activeIds.has(id))
      if (unknown.length > 0) return errorResponse(`unknown wikiIds: ${unknown.join(', ')}`, 400)
      room.setWikiBindings(ids)
      try { broadcast({ type: 'wiki_changed', roomId: room.profile.id, action: 'bound' }) } catch { /* ignore */ }
      return json({ ok: true, wikiIds: room.getWikiBindings() })
    },
  },

  // --- Agent bindings: replace ---
  {
    method: 'PUT',
    pattern: /^\/api\/agents\/([^/]+)\/wikis$/,
    handler: async (req, match, { system, broadcast }) => {
      const agent = system.team.getAgent(decodeURIComponent(match[1]!))
      const ai = agent ? asAIAgent(agent) : undefined
      if (!ai) return errorResponse('AI agent not found', 404)
      const body = await parseBody(req) as { wikiIds?: ReadonlyArray<unknown> } | null
      const ids = Array.isArray(body?.wikiIds)
        ? (body!.wikiIds as unknown[]).filter((v): v is string => typeof v === 'string')
        : []
      // Validate against the current active set (reconciles in passing).
      const merged = await resolveActiveWikis(system.wikisStorePath, system.wikiRegistry)
      const activeIds = new Set(merged.filter((w) => w.enabled).map((w) => w.id))
      const unknown = ids.filter((id) => !activeIds.has(id))
      if (unknown.length > 0) return errorResponse(`unknown wikiIds: ${unknown.join(', ')}`, 400)
      ai.updateWikiBindings(ids)
      try { broadcast({ type: 'wiki_changed', agentId: ai.id, action: 'bound' }) } catch { /* ignore */ }
      return json({ ok: true, wikiIds: ids })
    },
  },
]
