// ============================================================================
// Triggers admin routes — per-agent scheduled prompts.
//
// GET    /api/agents/:name/triggers           list this agent's triggers
// POST   /api/agents/:name/triggers           create — body: { name, prompt, mode, intervalSec, roomId, enabled? }
// PUT    /api/agents/:name/triggers/:id       update (partial body)
// DELETE /api/agents/:name/triggers/:id       remove
//
// All mutations broadcast `triggers_changed` so panels refresh, and call
// `system.triggerScheduler.invalidate()` so the cached "any triggers exist"
// flag and the start/stop state stay correct.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { validateTriggerInput, type Trigger, type TriggerMode } from '../../core/triggers/types.ts'

export const triggerRoutes: RouteEntry[] = [
  // --- List ---
  {
    method: 'GET',
    pattern: /^\/api\/agents\/([^/]+)\/triggers$/,
    handler: async (_req, match, { system }) => {
      const agent = system.team.getAgent(decodeURIComponent(match[1]!))
      if (!agent) return errorResponse('agent not found', 404)
      return json({ triggers: agent.getTriggers?.() ?? [] })
    },
  },
  // --- Create ---
  {
    method: 'POST',
    pattern: /^\/api\/agents\/([^/]+)\/triggers$/,
    handler: async (req, match, { system, broadcast }) => {
      const agent = system.team.getAgent(decodeURIComponent(match[1]!))
      if (!agent) return errorResponse('agent not found', 404)
      if (!agent.addTrigger) return errorResponse('agent does not support triggers', 400)
      const body = await parseBody(req)
      if (!body || typeof body !== 'object') return errorResponse('invalid body', 400)
      const err = validateTriggerInput(body as Record<string, unknown>, agent.kind)
      if (err) return errorResponse(err, 400)
      // Validate the pinned room exists.
      const roomId = (body as { roomId: string }).roomId
      if (!system.house.getRoom(roomId)) return errorResponse(`room "${roomId}" not found`, 404)

      const trigger: Trigger = {
        id: crypto.randomUUID(),
        name: ((body as { name: string }).name).trim(),
        prompt: ((body as { prompt: string }).prompt).trim(),
        mode: (body as { mode: TriggerMode }).mode,
        intervalSec: (body as { intervalSec: number }).intervalSec,
        enabled: (body as { enabled?: boolean }).enabled ?? true,
        roomId,
      }
      agent.addTrigger(trigger)
      system.triggerScheduler.invalidate()
      try { broadcast({ type: 'triggers_changed', agentId: agent.id, action: 'created', triggerId: trigger.id }) } catch { /* ignore */ }
      return json({ ok: true, trigger }, 201)
    },
  },
  // --- Update ---
  {
    method: 'PUT',
    pattern: /^\/api\/agents\/([^/]+)\/triggers\/([^/]+)$/,
    handler: async (req, match, { system, broadcast }) => {
      const agent = system.team.getAgent(decodeURIComponent(match[1]!))
      if (!agent) return errorResponse('agent not found', 404)
      if (!agent.updateTrigger || !agent.getTriggers) return errorResponse('agent does not support triggers', 400)
      const id = match[2]!
      const existing = agent.getTriggers().find(t => t.id === id)
      if (!existing) return errorResponse('trigger not found', 404)
      const body = await parseBody(req)
      if (!body || typeof body !== 'object') return errorResponse('invalid body', 400)

      // Build the merged shape and re-validate. Server is authoritative for
      // shape correctness — UI may send partial bodies but the result must
      // be valid in full.
      const patch = body as Partial<Trigger>
      const merged = {
        name: patch.name ?? existing.name,
        prompt: patch.prompt ?? existing.prompt,
        mode: patch.mode ?? existing.mode,
        intervalSec: patch.intervalSec ?? existing.intervalSec,
        enabled: patch.enabled ?? existing.enabled,
        roomId: patch.roomId ?? existing.roomId,
      }
      const err = validateTriggerInput(merged as Record<string, unknown>, agent.kind)
      if (err) return errorResponse(err, 400)
      if (!system.house.getRoom(merged.roomId)) return errorResponse(`room "${merged.roomId}" not found`, 404)

      agent.updateTrigger(id, {
        name: merged.name.trim(),
        prompt: merged.prompt.trim(),
        mode: merged.mode,
        intervalSec: merged.intervalSec,
        enabled: merged.enabled,
        roomId: merged.roomId,
      })
      system.triggerScheduler.invalidate()
      try { broadcast({ type: 'triggers_changed', agentId: agent.id, action: 'updated', triggerId: id }) } catch { /* ignore */ }
      return json({ ok: true })
    },
  },
  // --- Delete ---
  {
    method: 'DELETE',
    pattern: /^\/api\/agents\/([^/]+)\/triggers\/([^/]+)$/,
    handler: async (_req, match, { system, broadcast }) => {
      const agent = system.team.getAgent(decodeURIComponent(match[1]!))
      if (!agent) return errorResponse('agent not found', 404)
      if (!agent.deleteTrigger) return errorResponse('agent does not support triggers', 400)
      const id = match[2]!
      const removed = agent.deleteTrigger(id)
      if (!removed) return errorResponse('trigger not found', 404)
      system.triggerScheduler.invalidate()
      try { broadcast({ type: 'triggers_changed', agentId: agent.id, action: 'deleted', triggerId: id }) } catch { /* ignore */ }
      return json({ ok: true })
    },
  },
]
