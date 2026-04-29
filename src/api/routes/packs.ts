// ============================================================================
// Packs admin routes — install / update / uninstall / list packs from GitHub.
//
// GET    /api/packs                 list installed packs + their registered
//                                   tool/skill keys
// POST   /api/packs/install         body: { source: string; name?: string }
// POST   /api/packs/update/:name    git pull + re-register
// DELETE /api/packs/:name           unregister + rm -rf
//
// All mutations emit a `packs_changed` WS broadcast so open UIs refresh.
// Heavy lifting lives in the built-in pack tools — routes are thin wrappers
// that look up the registered tool and forward params, so REST and agent
// surfaces stay in lock-step.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { getAvailablePacks } from '../../packs/registry.ts'
import { loadDiscoverySources } from '../../core/discovery-sources.ts'

// Small helper: invoke a built-in pack tool and return its result as JSON.
const invoke = async (
  system: { toolRegistry: { get: (name: string) => { execute: (p: Record<string, unknown>, ctx: { callerId: string; callerName: string }) => Promise<{ success: boolean; data?: unknown; error?: string }> } | undefined } },
  toolName: string,
  params: Record<string, unknown>,
): Promise<Response> => {
  const tool = system.toolRegistry.get(toolName)
  if (!tool) return errorResponse(`Tool ${toolName} not registered`, 500)
  const result = await tool.execute(params, { callerId: 'api', callerName: 'api' })
  if (!result.success) return errorResponse(result.error ?? 'operation failed', 400)
  return json(result.data ?? {})
}

export const packsRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/packs$/,
    handler: async (_req, _match, { system }) => invoke(system, 'list_packs', {}),
  },
  {
    // Browse view — pack registry merged with installed flag. Powers the
    // "Available packs" section of the Packs modal. Cached 5 min server-side.
    method: 'GET',
    pattern: /^\/api\/packs\/registry$/,
    handler: async (_req, _match, { system }) => {
      const ds = await loadDiscoverySources(system.discoverySourcesStorePath)
      const { loadGithubTokens, mergeWithEnv } = await import('../../core/github-tokens.ts')
      const tokens = mergeWithEnv(await loadGithubTokens(system.githubTokensStorePath))
      const result = await getAvailablePacks({
        storedSources: ds.packs,
        storedToken: tokens.packRegistry.apiKey,
      })
      const available = result.items
      // Get installed list to mark each available pack. Registry names are
      // canonical (registry strips `samsinn-pack-` from repo basenames before
      // returning) and install_pack writes packs under the same canonical
      // namespace (manifest.name first, stripped basename fallback). So a
      // direct equality match is enough here — no prefix-stripping shim.
      const listTool = system.toolRegistry.get('list_packs')
      const installedRes = listTool
        ? await listTool.execute({}, { callerId: 'api', callerName: 'api' })
        : { success: false }
      const installed = installedRes.success && Array.isArray(installedRes.data)
        ? new Set((installedRes.data as Array<{ namespace: string }>).map(p => p.namespace))
        : new Set<string>()
      // Return failures alongside the registry so the UI can render a banner
      // when discovery hit rate limits / auth errors instead of falsely
      // implying the registry is empty.
      return json({
        items: available.map(p => ({ ...p, installed: installed.has(p.name) })),
        failures: result.failures,
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/packs\/install$/,
    handler: async (req, _match, { system, broadcast }) => {
      const body = await parseBody(req)
      if (typeof body.source !== 'string' || !body.source.trim()) {
        return errorResponse('source is required')
      }
      const params: Record<string, unknown> = { source: body.source.trim() }
      if (typeof body.name === 'string' && body.name.trim()) {
        params.name = body.name.trim()
      }
      const response = await invoke(system, 'install_pack', params)
      if (response.status === 200) {
        try { broadcast({ type: 'packs_changed' }) } catch { /* ignore */ }
      }
      return response
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/packs\/update\/([^/]+)$/,
    handler: async (_req, match, { system, broadcast }) => {
      const name = decodeURIComponent(match[1] ?? '')
      const response = await invoke(system, 'update_pack', { name })
      if (response.status === 200) {
        try { broadcast({ type: 'packs_changed' }) } catch { /* ignore */ }
      }
      return response
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/packs\/([^/]+)$/,
    handler: async (_req, match, { system, broadcast }) => {
      const name = decodeURIComponent(match[1] ?? '')
      const response = await invoke(system, 'uninstall_pack', { name })
      if (response.status === 200) {
        try { broadcast({ type: 'packs_changed' }) } catch { /* ignore */ }
      }
      return response
    },
  },
]
