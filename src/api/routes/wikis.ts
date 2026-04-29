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
import { loadWikiStore, saveWikiStore, mergeWithDiscovery, isValidWikiId, STORE_VERSION } from '../../wiki/store.ts'
import { asAIAgent } from '../../agents/shared.ts'
import type { WikiConfig } from '../../wiki/types.ts'
import { getAvailableWikis } from '../../wiki/discovery.ts'

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
      const { data: store, warnings } = await loadWikiStore(system.wikisStorePath)
      let discovered: Awaited<ReturnType<typeof getAvailableWikis>> = []
      try { discovered = await getAvailableWikis() } catch { /* discovery failures are non-fatal here */ }
      const merged = mergeWithDiscovery(store, discovered)
      // Reconcile the registry with the merged set. Discovered wikis added
      // after boot (org created, repos transferred in) need this to be
      // queryable + warmable. Idempotent — setWikis no-ops on identical input.
      const enabled = merged.filter((w) => w.enabled)
      const liveIds = new Set(system.wikiRegistry.list().map((w) => w.id))
      const enabledIds = new Set(enabled.map((w) => w.id))
      const idsDiffer = liveIds.size !== enabledIds.size
        || [...enabledIds].some((id) => !liveIds.has(id))
      if (idsDiffer) {
        system.wikiRegistry.setWikis(enabled)
        // Background warm of the just-added ones; UI will reflect pageCount
        // on its next poll/event without blocking this response.
        for (const w of enabled) {
          if (!liveIds.has(w.id)) {
            system.wikiRegistry.warm(w.id).catch((err) => {
              console.warn(`[wiki:${w.id}] background warm failed: ${(err as Error).message}`)
            })
          }
        }
      }
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
      let discovered2: Awaited<ReturnType<typeof getAvailableWikis>> = []
      try { discovered2 = await getAvailableWikis() } catch { /* non-fatal */ }
      const merged = mergeWithDiscovery(next, discovered2).filter((w) => w.enabled)
      system.wikiRegistry.setWikis(merged)

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
      let discovered2: Awaited<ReturnType<typeof getAvailableWikis>> = []
      try { discovered2 = await getAvailableWikis() } catch { /* non-fatal */ }
      const merged = mergeWithDiscovery(next, discovered2).filter((w) => w.enabled)
      system.wikiRegistry.setWikis(merged)
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
      // Re-merge with discovery so a delete that targets a stored override
      // of a discovered wiki leaves the discovered entry active. setWikis is
      // a diffing call: anything not in the new list is removed from the cache.
      let discoveredDel: Awaited<ReturnType<typeof getAvailableWikis>> = []
      try { discoveredDel = await getAvailableWikis() } catch { /* non-fatal */ }
      const mergedDel = mergeWithDiscovery(next, discoveredDel).filter((w) => w.enabled)
      system.wikiRegistry.setWikis(mergedDel)
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

  // --- Refresh (force warm) ---
  // Re-reconciles the registry with the merged stored+discovered set first.
  // Without this, wikis discovered AFTER the bootstrap setWikis() (e.g. the
  // operator added the org just now, or discovery's 5-min cache was empty
  // at boot) are visible in GET /api/wikis but absent from the live registry,
  // so refresh falls through to a 404 ("not found"). The reconcile makes
  // the refresh handler self-healing.
  {
    method: 'POST',
    pattern: /^\/api\/wikis\/([^/]+)\/refresh$/,
    handler: async (_req, match, { system, broadcast }) => {
      const id = match[1]!
      if (!system.wikiRegistry.hasWiki(id)) {
        const { data: store } = await loadWikiStore(system.wikisStorePath)
        let discovered: Awaited<ReturnType<typeof getAvailableWikis>> = []
        try { discovered = await getAvailableWikis() } catch { /* non-fatal */ }
        const merged = mergeWithDiscovery(store, discovered).filter((w) => w.enabled)
        if (merged.some((w) => w.id === id)) system.wikiRegistry.setWikis(merged)
      }
      if (!system.wikiRegistry.hasWiki(id)) return errorResponse(`wiki "${id}" not found`, 404)
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
      const unknown = ids.filter((id) => !system.wikiRegistry.hasWiki(id))
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
      const unknown = ids.filter((id) => !system.wikiRegistry.hasWiki(id))
      if (unknown.length > 0) return errorResponse(`unknown wikiIds: ${unknown.join(', ')}`, 400)
      ai.updateWikiBindings(ids)
      try { broadcast({ type: 'wiki_changed', agentId: ai.id, action: 'bound' }) } catch { /* ignore */ }
      return json({ ok: true, wikiIds: ids })
    },
  },
]
