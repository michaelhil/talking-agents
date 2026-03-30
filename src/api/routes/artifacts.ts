import { json, errorResponse, parseBody } from '../http-routes.ts'
import type { RouteEntry } from './types.ts'

export const artifactRoutes: RouteEntry[] = [
  // List all registered artifact types
  {
    method: 'GET',
    pattern: /^\/api\/artifact-types$/,
    handler: (_req, _match, { system }) =>
      json(system.house.artifactTypes.list().map(t => ({
        type: t.type,
        description: t.description,
        bodySchema: t.bodySchema,
      }))),
  },
  // List all artifacts (optional query: type, scope room ID, includeResolved)
  {
    method: 'GET',
    pattern: /^\/api\/artifacts$/,
    handler: (req, _match, { system }) => {
      const url = new URL(req.url)
      const type = url.searchParams.get('type') ?? undefined
      const scope = url.searchParams.get('scope') ?? undefined
      const includeResolved = url.searchParams.get('includeResolved') === 'true'
      return json(system.house.artifacts.list({ type, scope, includeResolved }))
    },
  },
  // Create a new artifact
  {
    method: 'POST',
    pattern: /^\/api\/artifacts$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (!body.artifactType || typeof body.artifactType !== 'string') return errorResponse('artifactType is required')
      if (!body.title || typeof body.title !== 'string') return errorResponse('title is required')
      if (!body.body || typeof body.body !== 'object') return errorResponse('body is required')

      const typeDef = system.house.artifactTypes.get(body.artifactType)
      if (!typeDef) return errorResponse(`Unknown artifact type "${body.artifactType}"`, 400)

      // Resolve scope: room names → room IDs
      const scopeNames = body.scope as string[] | undefined
      const scope: string[] = []
      if (Array.isArray(scopeNames)) {
        for (const name of scopeNames) {
          const room = system.house.getRoom(name)
          if (!room) return errorResponse(`Room "${name}" not found`, 404)
          scope.push(room.profile.id)
        }
      }

      const artifact = system.house.artifacts.add({
        type: body.artifactType,
        title: body.title,
        ...(body.description !== undefined ? { description: body.description as string } : {}),
        body: body.body as Record<string, unknown>,
        scope,
        createdBy: (body.createdBy as string) ?? 'system',
      })
      return json(artifact, 201)
    },
  },
  // Get a single artifact
  {
    method: 'GET',
    pattern: /^\/api\/artifacts\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const id = decodeURIComponent(match[1]!)
      const artifact = system.house.artifacts.get(id)
      if (!artifact) return errorResponse(`Artifact "${id}" not found`, 404)
      return json(artifact)
    },
  },
  // Update an artifact
  {
    method: 'PUT',
    pattern: /^\/api\/artifacts\/([^/]+)$/,
    handler: async (req, match, { system }) => {
      const id = decodeURIComponent(match[1]!)
      const body = await parseBody(req)
      const updated = system.house.artifacts.update(id, {
        title: body.title as string | undefined,
        description: body.description as string | undefined,
        body: body.body as Record<string, unknown> | undefined,
        resolution: body.resolution as string | undefined,
      })
      if (!updated) return errorResponse(`Artifact "${id}" not found`, 404)
      return json(updated)
    },
  },
  // Delete an artifact
  {
    method: 'DELETE',
    pattern: /^\/api\/artifacts\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const id = decodeURIComponent(match[1]!)
      const removed = system.house.artifacts.remove(id)
      if (!removed) return errorResponse(`Artifact "${id}" not found`, 404)
      return json({ removed: true })
    },
  },
  // List artifacts scoped to a specific room (convenience route)
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/artifacts$/,
    handler: (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const url = new URL(req.url)
      const type = url.searchParams.get('type') ?? undefined
      const includeResolved = url.searchParams.get('includeResolved') === 'true'
      return json(system.house.artifacts.list({ scope: room.profile.id, type, includeResolved }))
    },
  },
]
