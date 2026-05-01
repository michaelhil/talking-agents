import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MessageTarget } from '../../../core/types/messaging.ts'
import type { System } from '../../../main.ts'
import { textResult, errorResult, resolveRoom } from './helpers.ts'
import { asAIAgent } from '../../../agents/shared.ts'
import { exportRoomConversation } from '../../../core/rooms/room-export.ts'
import { waitForRoomIdle } from '../../../core/wait-for-idle.ts'

export const registerMessageTools = (mcpServer: McpServer, system: System): void => {
  mcpServer.tool(
    'post_message',
    'Post a message to one or more rooms. Use this to inject messages into conversations.',
    {
      content: z.string().describe('Message content'),
      senderId: z.string().default('mcp-client').describe('Sender ID'),
      senderName: z.string().optional().describe('Sender display name'),
      roomNames: z.array(z.string()).describe('Room names to post to'),
    },
    async ({ content, senderId, senderName, roomNames }) => {
      try {
        const target: MessageTarget = { rooms: roomNames }
        const messages = system.routeMessage(target, {
          senderId,
          senderName: senderName ?? senderId,
          content,
          type: 'chat',
        })
        return textResult({ delivered: messages.length, messages })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to post message')
      }
    },
  )

  mcpServer.tool(
    'get_room_messages',
    'Get recent messages from a room',
    {
      roomName: z.string().describe('Room name'),
      limit: z.number().default(50).describe('Max messages to return'),
    },
    async ({ roomName, limit }) => {
      try {
        const room = resolveRoom(system, roomName)
        return textResult(room.getRecent(limit))
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Room not found')
      }
    },
  )

  mcpServer.tool(
    'list_artifact_types',
    'List all registered artifact types with their descriptions and body schemas',
    {},
    async () => {
      try {
        const types = system.house.artifactTypes.list().map(def => ({
          type: def.type,
          description: def.description,
          bodySchema: def.bodySchema,
        }))
        return textResult(types)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to list artifact types')
      }
    },
  )

  mcpServer.tool(
    'list_artifacts',
    'List artifacts. Filter by type, scope (room name), and whether to include resolved.',
    {
      type: z.string().optional().describe('Filter by artifact type'),
      roomName: z.string().optional().describe('Filter to artifacts scoped to this room (plus system-wide)'),
      includeResolved: z.boolean().default(false).describe('Include already-resolved artifacts'),
    },
    async ({ type, roomName, includeResolved }) => {
      try {
        let artifacts
        if (roomName) {
          const room = resolveRoom(system, roomName)
          artifacts = system.house.artifacts.getForScope(room.profile.id)
        } else {
          artifacts = system.house.artifacts.list(type ? { type } : undefined)
        }
        if (type && roomName) {
          artifacts = artifacts.filter(a => a.type === type)
        }
        if (!includeResolved) {
          artifacts = artifacts.filter(a => !a.resolvedAt)
        }
        return textResult(artifacts)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to list artifacts')
      }
    },
  )

  mcpServer.tool(
    'add_artifact',
    'Create a new artifact. Use list_artifact_types to see available types and their body schemas.',
    {
      type: z.string().describe('Artifact type (e.g. task_list, poll, document)'),
      title: z.string().describe('Human-readable title'),
      description: z.string().optional().describe('Optional longer description'),
      body: z.record(z.string(), z.unknown()).describe('Type-specific body (see list_artifact_types for schema)'),
      scope: z.array(z.string()).optional().describe('Room names to scope this artifact to (empty = system-wide)'),
    },
    async ({ type, title, description, body, scope }) => {
      try {
        const typeDef = system.house.artifactTypes.get(type)
        if (!typeDef) return errorResult(`Unknown artifact type "${type}"`)
        const scopeIds: string[] = []
        for (const roomName of (scope ?? [])) {
          const room = system.house.getRoom(roomName)
          if (!room) return errorResult(`Room "${roomName}" not found`)
          scopeIds.push(room.profile.id)
        }
        const artifact = system.house.artifacts.add({
          type,
          title,
          ...(description !== undefined ? { description } : {}),
          body,
          scope: scopeIds,
          createdBy: 'mcp-client',
        })
        return textResult(artifact)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to add artifact')
      }
    },
  )

  mcpServer.tool(
    'update_artifact',
    'Update an artifact title, body, or explicitly resolve it.',
    {
      artifactId: z.string().describe('Artifact ID'),
      title: z.string().optional().describe('New title'),
      body: z.record(z.string(), z.unknown()).optional().describe('Body updates (merged with existing)'),
      resolution: z.string().optional().describe('Resolve the artifact with this comment'),
    },
    async ({ artifactId, title, body, resolution }) => {
      try {
        const updated = system.house.artifacts.update(
          artifactId,
          { title, body, resolution },
          { callerId: 'mcp-client', callerName: 'mcp-client' },
        )
        if (!updated) return errorResult(`Artifact "${artifactId}" not found`)
        return textResult(updated)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to update artifact')
      }
    },
  )

  mcpServer.tool(
    'remove_artifact',
    'Remove an artifact by ID',
    { artifactId: z.string().describe('Artifact ID') },
    async ({ artifactId }) => {
      try {
        const removed = system.house.artifacts.remove(artifactId)
        if (!removed) return errorResult(`Artifact "${artifactId}" not found`)
        return textResult({ removed: true })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to remove artifact')
      }
    },
  )

  mcpServer.tool(
    'wait_for_idle',
    'Wait for a room to become idle. Returns {idle, capped, messageCount, lastMessageAt, elapsedMs}. Idle = no new message for quietMs AND all in-room AI agents resolved whenIdle. Capped = room hit maxMessages before quiescence (if set). Polls every 500ms.',
    {
      roomName: z.string().describe('Room name'),
      quietMs: z.number().int().default(5000).describe('Quiet period before idle fires (ms)'),
      timeoutMs: z.number().int().default(120000).describe('Max wait before returning idle:false (ms)'),
      maxMessages: z.number().int().optional().describe('Hard cap on room message count. When reached, returns with capped:true immediately — useful for preventing runaway agent loops.'),
    },
    async ({ roomName, quietMs, timeoutMs, maxMessages }) => {
      try {
        const room = resolveRoom(system, roomName)
        const result = await waitForRoomIdle(room, {
          quietMs,
          timeoutMs,
          ...(maxMessages !== undefined ? { maxMessages } : {}),
          inRoomAIAgents: () => room.getParticipantIds()
            .map(id => system.team.getAgent(id))
            .flatMap(a => { const ai = a ? asAIAgent(a) : null; return ai ? [ai] : [] }),
        })
        return textResult(result)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'wait_for_idle failed')
      }
    },
  )

  mcpServer.tool(
    'export_room',
    'Export the full conversation of a room as JSON: {roomId, roomName, exportedAt, messageCount, messages}. Each message carries all telemetry fields the system records (tokens, provider, model, generationMs).',
    {
      roomName: z.string().describe('Room name'),
    },
    async ({ roomName }) => {
      try {
        const room = resolveRoom(system, roomName)
        return textResult(exportRoomConversation(room))
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'export_room failed')
      }
    },
  )

  mcpServer.tool(
    'cast_vote',
    'Cast a vote on a poll artifact',
    {
      artifactId: z.string().describe('Poll artifact ID'),
      optionId: z.string().describe('Option ID to vote for'),
      voterId: z.string().default('mcp-client').describe('ID of the voter'),
      voterName: z.string().default('mcp-client').describe('Name of the voter'),
    },
    async ({ artifactId, optionId, voterId, voterName }) => {
      try {
        const artifact = system.house.artifacts.get(artifactId)
        if (!artifact) return errorResult(`Artifact "${artifactId}" not found`)
        if (artifact.type !== 'poll') return errorResult(`Artifact "${artifactId}" is not a poll`)
        const updated = system.house.artifacts.update(
          artifactId,
          { body: { castVote: optionId } },
          { callerId: voterId, callerName: voterName },
        )
        if (!updated) return errorResult(`Failed to cast vote`)
        return textResult(updated)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to cast vote')
      }
    },
  )
}
