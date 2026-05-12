import { json, errorResponse, parseBody } from './helpers.ts'
import { SYSTEM_SENDER_ID } from '../../core/types/constants.ts'
import { SETTABLE_DELIVERY_MODES } from '../../core/types/messaging.ts'
import type { SettableDeliveryMode } from '../../core/types/messaging.ts'
import { validateSummaryConfig } from '../../core/types/summary.ts'
import type { RouteEntry } from './types.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { exportRoomConversation } from '../../core/rooms/room-export.ts'

export const roomRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/rooms$/,
    handler: (_req, _match, { system }) => json(system.house.listAllRooms()),
  },
  {
    method: 'POST',
    pattern: /^\/api\/rooms$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (!body.name || typeof body.name !== 'string') return errorResponse('name is required')
      try {
        const result = system.house.createRoomSafe({
          name: body.name,
          roomPrompt: body.roomPrompt as string | undefined,
          createdBy: (body.createdBy as string) ?? SYSTEM_SENDER_ID,
        })
        return json(result, 201)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Failed to create room')
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)$/,
    handler: (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const limit = parseInt(new URL(req.url).searchParams.get('limit') ?? '50', 10)
      return json({ profile: room.profile, messages: room.getRecent(limit) })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/export$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      return json(exportRoomConversation(room))
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/rooms\/([^/]+)\/messages\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const messageId = decodeURIComponent(match[2]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const deleted = room.deleteMessage(messageId)
      if (!deleted) return errorResponse(`Message "${messageId}" not found`, 404)
      return json({ deleted: true, messageId })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/rooms\/([^/]+)\/messages$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const count = room.getMessageCount()
      room.clearMessages()
      // Also wipe per-agent memory of this room so AI participants don't
      // retain phantom history of cleared messages.
      for (const agentId of room.getParticipantIds()) {
        const agent = system.team.getAgent(agentId)
        const ai = agent ? asAIAgent(agent) : undefined
        ai?.clearHistory?.(room.profile.id)
      }
      return json({ cleared: true, count })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/rooms\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      system.removeRoom(room.profile.id)
      return json({ removed: true })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/prompt$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      if (typeof body.roomPrompt !== 'string') return errorResponse('roomPrompt is required')
      room.setRoomPrompt(body.roomPrompt)
      return json({ roomPrompt: room.profile.roomPrompt })
    },
  },
  {
    // List packs activated in this room. Implicit-active packs ('core',
    // 'local') are NOT included — those are always active and not under
    // operator control.
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/packs$/,
    handler: async (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      return json({ activePacks: room.getActivePacks() })
    },
  },
  {
    // Replace activation list. Validates each entry against installed packs;
    // unknown namespaces fail the whole request (atomic — no partial sets).
    // 'core' and 'local' are filtered from the input if present (they're
    // always active and don't belong in the stored list).
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/packs$/,
    handler: async (req, match, { system, broadcastToInstance, instanceId }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req) as { activePacks?: ReadonlyArray<unknown> } | null
      const requested = Array.isArray(body?.activePacks)
        ? (body!.activePacks as unknown[]).filter((v): v is string => typeof v === 'string')
        : []
      const filtered = requested.filter(p => p !== 'core' && p !== 'local')

      // Validate against installed packs via the list_packs tool — same
      // truth source the UI uses, no parallel scanner.
      const listTool = system.toolRegistry.get('list_packs')
      const installed = listTool
        ? await listTool.execute({}, { callerId: 'api', callerName: 'api' })
        : { success: false }
      const installedSet = installed.success && Array.isArray(installed.data)
        ? new Set((installed.data as Array<{ namespace: string }>).map(p => p.namespace))
        : new Set<string>()
      const unknown = filtered.filter(ns => !installedSet.has(ns))
      if (unknown.length > 0) return errorResponse(`unknown pack namespaces: ${unknown.join(', ')}`, 400)

      room.setActivePacks(filtered)
      // Per-instance state — pack activation is scoped to one tenant's room.
      // The previous global `broadcast(...)` fanned out to every connected
      // tenant; their UI handlers no-oped on unfamiliar roomId but the
      // re-fetch traffic was wasted. RouteContext.broadcastToInstance is
      // typed optional (MCP-mode shape compatibility); pack-activation
      // routes only register in HTTP mode where it's always wired.
      try {
        broadcastToInstance?.(instanceId, { type: 'pack_activation_changed', roomId: room.profile.id, activePacks: filtered })
      } catch { /* ignore */ }
      return json({ activePacks: room.getActivePacks() })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/members$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const members = room.getParticipantIds().map(id => {
        const agent = system.team.getAgent(id)
        return agent ? { id: agent.id, name: agent.name, kind: agent.kind } : { id }
      })
      return json(members)
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/rooms\/([^/]+)\/members$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const agentName = body.agentName as string | undefined
      if (!agentName) return errorResponse('agentName is required')
      const agent = system.team.getAgent(agentName)
      if (!agent) return errorResponse(`Agent "${agentName}" not found`, 404)
      await system.addAgentToRoom(agent.id, room.profile.id)
      return json({ added: true, agentName: agent.name, roomName: room.profile.name })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/rooms\/([^/]+)\/members\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const rName = decodeURIComponent(match[1]!)
      const aName = decodeURIComponent(match[2]!)
      const room = system.house.getRoom(rName)
      if (!room) return errorResponse(`Room "${rName}" not found`, 404)
      const agent = system.team.getAgent(aName)
      if (!agent) return errorResponse(`Agent "${aName}" not found`, 404)
      system.removeAgentFromRoom(agent.id, room.profile.id)
      return json({ removed: true, agentName: agent.name, roomName: room.profile.name })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/delivery-mode$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const rawMode = body.mode as string
      if (!SETTABLE_DELIVERY_MODES.includes(rawMode as SettableDeliveryMode)) {
        return errorResponse(`Invalid mode "${rawMode}". Valid: ${SETTABLE_DELIVERY_MODES.join(', ')}`, 400)
      }
      room.setDeliveryMode(rawMode as SettableDeliveryMode)
      return json({ mode: room.deliveryMode })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/pause$/,
    handler: async (req, match, { system, broadcast }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      if (typeof body.paused !== 'boolean') return errorResponse('paused must be a boolean')
      room.setPaused(body.paused)
      broadcast({ type: 'delivery_mode_changed', roomName: room.profile.name, mode: room.deliveryMode, paused: room.paused })
      return json({ paused: room.paused })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/mute$/,
    handler: async (req, match, { system, broadcast }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      if (typeof body.agentName !== 'string') return errorResponse('agentName is required')
      if (typeof body.muted !== 'boolean') return errorResponse('muted must be a boolean')
      const agent = system.team.getAgent(body.agentName)
      if (!agent) return errorResponse(`Agent "${body.agentName}" not found`, 404)
      room.setMuted(agent.id, body.muted)
      broadcast({ type: 'mute_changed', roomName: room.profile.name, agentName: agent.name, muted: body.muted })
      return json({ muted: room.isMuted(agent.id) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/rooms\/([^/]+)\/agents\/([^/]+)\/activate$/,
    handler: (_req, match, { system }) => {
      const roomName = decodeURIComponent(match[1]!)
      const agentName = decodeURIComponent(match[2]!)
      const room = system.house.getRoom(roomName)
      if (!room) return errorResponse(`Room "${roomName}" not found`, 404)
      const agent = system.team.getAgent(agentName)
      if (!agent) return errorResponse(`Agent "${agentName}" not found`, 404)
      const result = system.activateAgentInRoom(agent.id, room.profile.id)
      return json(result, result.ok ? 200 : 400)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/summary-config$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      return json(room.summaryConfig)
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/summary-config$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      // Validate at the trust boundary. The previous version did
      // `body as unknown as SummaryConfig` which TS-accepted any shape
      // and pushed failure to runtime in unpredictable places (an
      // invalid schedule.kind could silently break the scheduler).
      const result = validateSummaryConfig(body)
      if (result.ok === false) return errorResponse(result.error, 400)
      room.setSummaryConfig(result.value)
      return json(room.summaryConfig)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/summary$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const compression = room.getCurrentCompressionMessage()
      return json({
        summary: room.getLatestSummary() ?? null,
        compression: compression ? { id: compression.id, content: compression.content, timestamp: compression.timestamp } : null,
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/rooms\/([^/]+)\/summary\/regenerate$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const target = body.target as 'summary' | 'compression' | 'both'
      if (target !== 'summary' && target !== 'compression' && target !== 'both') {
        return errorResponse('target must be "summary", "compression", or "both"', 400)
      }
      // Fire and forget — the WS events carry progress + completion.
      void system.summaryScheduler.triggerNow(room.profile.id, target)
      return json({ triggered: target })
    },
  },
]
