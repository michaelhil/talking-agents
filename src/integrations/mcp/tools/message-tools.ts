import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MessageTarget } from '../../../core/types.ts'
import type { System } from '../../../main.ts'
import { resolveFlowArtifact, isFlowError } from '../../../core/flow-artifact.ts'
import { textResult, errorResult, resolveRoom } from './helpers.ts'

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
    'start_flow',
    'Start a flow execution from a flow artifact. Optionally post a trigger message first.',
    {
      roomName: z.string().describe('Room name'),
      flowArtifactId: z.string().describe('Flow artifact ID'),
      content: z.string().optional().describe('Optional trigger message to post before starting'),
      senderId: z.string().default('mcp-client').describe('Sender ID for the trigger message'),
      senderName: z.string().optional().describe('Sender display name for the trigger message'),
    },
    async ({ roomName, flowArtifactId, content, senderId, senderName }) => {
      try {
        const room = resolveRoom(system, roomName)
        const artifact = system.house.artifacts.get(flowArtifactId)
        if (!artifact) return errorResult(`Flow artifact "${flowArtifactId}" not found`)
        const flow = resolveFlowArtifact(artifact, system.team, room.profile.roomPrompt)
        if (isFlowError(flow)) return errorResult(flow.error)
        if (content) {
          room.setPaused(true)
          room.post({ senderId, senderName: senderName ?? senderId, content, type: 'chat' })
        }
        room.startFlow(flow)
        return textResult({ started: true, mode: room.deliveryMode })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to start flow')
      }
    },
  )

  mcpServer.tool(
    'cancel_flow',
    'Cancel the currently active flow in a room',
    { roomName: z.string().describe('Room name') },
    async ({ roomName }) => {
      try {
        const room = resolveRoom(system, roomName)
        room.cancelFlow()
        return textResult({ cancelled: true, mode: room.deliveryMode })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to cancel flow')
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
      type: z.string().describe('Artifact type (e.g. task_list, poll, flow)'),
      title: z.string().describe('Human-readable title'),
      description: z.string().optional().describe('Optional longer description'),
      body: z.record(z.unknown()).describe('Type-specific body (see list_artifact_types for schema)'),
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
      body: z.record(z.unknown()).optional().describe('Body updates (merged with existing)'),
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
