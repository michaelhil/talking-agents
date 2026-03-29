// ============================================================================
// Artifact Tools — Generic CRUD tools for the Artifact system.
//
// Five tools available to agents:
//   list_artifact_types  — discover what artifact types exist
//   list_artifacts       — list artifacts visible to the current room
//   add_artifact         — create a new artifact
//   update_artifact      — update title, body, or explicitly resolve
//   remove_artifact      — delete an artifact
//   cast_vote            — vote on a poll (dedicated action)
//
// All tools resolve the current room from context.roomId when no roomName given.
// Scope accepts room names (resolved to IDs at the boundary).
// ============================================================================

import type { House, Tool, ToolContext } from '../../core/types.ts'
import { resolveRoom } from './resolve.ts'

export const createListArtifactTypesTool = (house: House): Tool => ({
  name: 'list_artifact_types',
  description: 'Lists all registered artifact types with their descriptions and body schemas.',
  usage: 'Use to discover what kinds of artifacts you can create (task lists, polls, flows, etc.).',
  returns: 'Array of { type, description, bodySchema }.',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (_params, _context) => ({
    success: true,
    data: house.artifactTypes.list().map(t => ({
      type: t.type,
      description: t.description,
      bodySchema: t.bodySchema,
    })),
  }),
})

export const createListArtifactsTool = (house: House): Tool => ({
  name: 'list_artifacts',
  description: 'Lists artifacts visible to the current room (scoped to it, not system-wide). Filter by type or include resolved.',
  usage: 'Use to check active task lists, open polls, or available flow blueprints. Omit roomName to use the current room.',
  returns: 'Array of artifact objects with id, type, title, body, scope, resolution.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Room name (omit to use current room)' },
      type: { type: 'string', description: 'Filter by artifact type (e.g. "task_list", "poll", "flow")' },
      includeResolved: { type: 'boolean', description: 'Include resolved/closed artifacts (default: false)' },
    },
    required: [],
  },
  execute: async (params, context) => {
    const room = resolveRoom(house, params, context)
    if (!room) return { success: false, error: 'Room not found — provide roomName or call from a room context' }
    const artifacts = house.artifacts.list({
      scope: room.profile.id,
      type: params.type as string | undefined,
      includeResolved: params.includeResolved as boolean | undefined,
    })
    return { success: true, data: artifacts }
  },
})

export const createAddArtifactTool = (house: House): Tool => ({
  name: 'add_artifact',
  description: 'Creates a new artifact (task list, poll, flow blueprint, etc.).',
  usage: 'Use to create a shared task list, start a poll, or define a reusable flow. Use list_artifact_types to see available types and required body fields.',
  returns: 'The created artifact object.',
  parameters: {
    type: 'object',
    properties: {
      artifactType: { type: 'string', description: 'Type of artifact to create (e.g. "task_list", "poll", "flow")' },
      title: { type: 'string', description: 'Human-readable name for this artifact' },
      body: { type: 'object', description: 'Type-specific body data (see list_artifact_types for schema)' },
      scope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Room names to scope this artifact to. Omit for system-wide.',
      },
    },
    required: ['artifactType', 'title', 'body'],
  },
  execute: async (params, context) => {
    const type = params.artifactType as string
    const typeDef = house.artifactTypes.get(type)
    if (!typeDef) return { success: false, error: `Unknown artifact type "${type}". Use list_artifact_types to see available types.` }

    // Resolve scope: room names → room IDs
    const scopeNames = params.scope as string[] | undefined
    const scope: string[] = []
    if (scopeNames) {
      for (const name of scopeNames) {
        const room = house.getRoom(name)
        if (!room) return { success: false, error: `Room "${name}" not found` }
        scope.push(room.profile.id)
      }
    } else if (context.roomId) {
      // Default scope: current room
      scope.push(context.roomId)
    }

    const artifact = house.artifacts.add({
      type,
      title: params.title as string,
      body: params.body as Record<string, unknown>,
      scope,
      createdBy: context.callerName,
    })
    return { success: true, data: artifact }
  },
})

export const createUpdateArtifactTool = (house: House): Tool => ({
  name: 'update_artifact',
  description: 'Updates an artifact\'s title, body, or explicitly resolves/closes it.',
  usage: 'Use to update task list tasks (op: "add_task", "complete_task", "update_task", "remove_task"), change a title, or close a poll with a resolution. Always include a result when completing tasks.',
  returns: 'The updated artifact.',
  parameters: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'ID of the artifact to update' },
      title: { type: 'string', description: 'New title (optional)' },
      body: { type: 'object', description: 'Body updates. For task_list, use op field for task operations.' },
      resolution: { type: 'string', description: 'Resolve/close this artifact with an explanation' },
    },
    required: ['artifactId'],
  },
  execute: async (params, context) => {
    const ctx: ToolContext = context
    const updated = house.artifacts.update(
      params.artifactId as string,
      {
        title: params.title as string | undefined,
        body: params.body as Record<string, unknown> | undefined,
        resolution: params.resolution as string | undefined,
      },
      ctx,
    )
    if (!updated) return { success: false, error: `Artifact "${params.artifactId}" not found` }
    return { success: true, data: updated }
  },
})

export const createRemoveArtifactTool = (house: House): Tool => ({
  name: 'remove_artifact',
  description: 'Permanently removes an artifact.',
  usage: 'Use to delete an artifact that is no longer needed. Prefer resolving (update_artifact with resolution) over removing for audit purposes.',
  returns: '{ removed: true } on success.',
  parameters: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'ID of the artifact to remove' },
    },
    required: ['artifactId'],
  },
  execute: async (params, _context) => {
    const removed = house.artifacts.remove(params.artifactId as string)
    if (!removed) return { success: false, error: `Artifact "${params.artifactId}" not found` }
    return { success: true, data: { removed: true } }
  },
})

export const createCastVoteTool = (house: House): Tool => ({
  name: 'cast_vote',
  description: 'Cast a vote on a poll artifact.',
  usage: 'Use to vote on an open poll. Use list_artifacts to find the poll ID and available option IDs.',
  returns: 'The updated poll artifact.',
  parameters: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'ID of the poll artifact' },
      optionId: { type: 'string', description: 'ID of the option to vote for' },
    },
    required: ['artifactId', 'optionId'],
  },
  execute: async (params, context) => {
    const ctx: ToolContext = context
    const updated = house.artifacts.update(
      params.artifactId as string,
      { body: { castVote: params.optionId } },
      ctx,
    )
    if (!updated) return { success: false, error: `Poll artifact "${params.artifactId}" not found` }
    return { success: true, data: updated }
  },
})
