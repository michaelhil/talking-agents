import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import type { System } from '../../main.ts'
import { parseOllamaConfigPatch, type LLMGateway } from '../../llm/gateway.ts'

// Guard: all /api/ollama/* routes need Ollama to be a configured provider.
// When Ollama is excluded from the router, these endpoints return 503.
const requireOllama = (system: System): LLMGateway | Response => {
  if (!system.ollama) {
    return errorResponse('Ollama is not a configured provider in this deployment', 503)
  }
  return system.ollama
}

export const ollamaRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/ollama\/health$/,
    handler: (_req, _match, { system }) => {
      const gw = requireOllama(system); if (gw instanceof Response) return gw
      return json(gw.getHealth())
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ollama\/metrics$/,
    handler: (_req, _match, { system }) => {
      const gw = requireOllama(system); if (gw instanceof Response) return gw
      return json(gw.getMetrics())
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ollama\/models$/,
    handler: async (_req, _match, { system }) => {
      const gw = requireOllama(system); if (gw instanceof Response) return gw
      const health = gw.getHealth()
      return json({
        loaded: health.loadedModels,
        available: health.availableModels,
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/ollama\/models\/([^/]+)\/load$/,
    handler: async (_req, match, { system }) => {
      const gw = requireOllama(system); if (gw instanceof Response) return gw
      const name = decodeURIComponent(match[1] ?? '')
      if (!name) return errorResponse('Model name required')
      try {
        await gw.loadModel(name)
        return json({ loaded: true, model: name })
      } catch (err) {
        return errorResponse(`Failed to load model: ${err instanceof Error ? err.message : err}`, 502)
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/ollama\/models\/([^/]+)\/unload$/,
    handler: async (_req, match, { system }) => {
      const gw = requireOllama(system); if (gw instanceof Response) return gw
      const name = decodeURIComponent(match[1] ?? '')
      if (!name) return errorResponse('Model name required')
      try {
        await gw.unloadModel(name)
        return json({ unloaded: true, model: name })
      } catch (err) {
        return errorResponse(`Failed to unload model: ${err instanceof Error ? err.message : err}`, 502)
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/ollama\/reset-circuit$/,
    handler: (_req, _match, { system }) => {
      const gw = requireOllama(system); if (gw instanceof Response) return gw
      gw.resetCircuitBreaker()
      return json({ reset: true, health: gw.getHealth() })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ollama\/config$/,
    handler: (_req, _match, { system }) => {
      const gw = requireOllama(system); if (gw instanceof Response) return gw
      return json(gw.getConfig())
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/ollama\/config$/,
    handler: async (req, _match, { system }) => {
      const gw = requireOllama(system); if (gw instanceof Response) return gw
      gw.updateConfig(parseOllamaConfigPatch(await parseBody(req)))
      return json(gw.getConfig())
    },
  },
]
