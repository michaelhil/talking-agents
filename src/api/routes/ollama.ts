import { json, errorResponse, parseBody } from '../http-routes.ts'
import type { RouteEntry } from './types.ts'

export const ollamaRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/ollama\/health$/,
    handler: (_req, _match, { system }) => json(system.ollama.getHealth()),
  },
  {
    method: 'GET',
    pattern: /^\/api\/ollama\/metrics$/,
    handler: (_req, _match, { system }) => json(system.ollama.getMetrics()),
  },
  {
    method: 'GET',
    pattern: /^\/api\/ollama\/models$/,
    handler: async (_req, _match, { system }) => {
      const health = system.ollama.getHealth()
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
      const name = decodeURIComponent(match[1] ?? '')
      if (!name) return errorResponse('Model name required')
      try {
        await system.ollama.loadModel(name)
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
      const name = decodeURIComponent(match[1] ?? '')
      if (!name) return errorResponse('Model name required')
      try {
        await system.ollama.unloadModel(name)
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
      system.ollama.resetCircuitBreaker()
      return json({ reset: true, health: system.ollama.getHealth() })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ollama\/config$/,
    handler: (_req, _match, { system }) => json(system.ollama.getConfig()),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/ollama\/config$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      const update: Record<string, unknown> = {}
      if (typeof body.maxConcurrent === 'number') update.maxConcurrent = body.maxConcurrent
      if (typeof body.maxQueueDepth === 'number') update.maxQueueDepth = body.maxQueueDepth
      if (typeof body.queueTimeoutMs === 'number') update.queueTimeoutMs = body.queueTimeoutMs
      if (typeof body.circuitBreakerThreshold === 'number') update.circuitBreakerThreshold = body.circuitBreakerThreshold
      if (typeof body.circuitBreakerCooldownMs === 'number') update.circuitBreakerCooldownMs = body.circuitBreakerCooldownMs
      if (typeof body.keepAlive === 'string') update.keepAlive = body.keepAlive
      if (typeof body.healthPollIntervalMs === 'number') update.healthPollIntervalMs = body.healthPollIntervalMs
      system.ollama.updateConfig(update)
      return json(system.ollama.getConfig())
    },
  },
]
