import type { WSInbound } from '../../core/types/ws-protocol.ts'
import { sendError, type CommandContext } from './types.ts'

export const handleArtifactCommand = (msg: WSInbound, ctx: CommandContext): boolean => {
  const { ws, session, system, wsManager } = ctx

  switch (msg.type) {
    case 'add_artifact': {
      const typeDef = system.house.artifactTypes.get(msg.artifactType)
      if (!typeDef) {
        sendError(wsManager, ws, `Unknown artifact type "${msg.artifactType}"`)
        return true
      }
      // Resolve scope: room names → IDs
      const scope: string[] = []
      if (msg.scope) {
        for (const name of msg.scope) {
          const room = system.house.getRoom(name)
          if (!room) {
            sendError(wsManager, ws, `Room "${name}" not found`)
            return true
          }
          scope.push(room.profile.id)
        }
      }
      const created = system.house.artifacts.add({
        type: msg.artifactType,
        title: msg.title,
        ...(msg.description !== undefined ? { description: msg.description } : {}),
        body: msg.body,
        scope,
        createdBy: session.agent.name,
      })
      if (msg.requestId) {
        wsManager.safeSend(ws, JSON.stringify({
          type: 'artifact_created',
          requestId: msg.requestId,
          artifactId: created.id,
          artifactType: created.type,
        }))
      }
      return true
    }

    case 'update_artifact': {
      const updated = system.house.artifacts.update(
        msg.artifactId,
        {
          title: msg.title,
          body: msg.body,
          resolution: msg.resolution,
        },
        { callerId: session.agent.id, callerName: session.agent.name },
      )
      if (!updated) sendError(wsManager, ws, `Artifact "${msg.artifactId}" not found`)
      return true
    }

    case 'remove_artifact': {
      const removed = system.house.artifacts.remove(msg.artifactId)
      if (!removed) sendError(wsManager, ws, `Artifact "${msg.artifactId}" not found`)
      return true
    }

    case 'cast_vote': {
      const artifact = system.house.artifacts.get(msg.artifactId)
      if (!artifact) {
        sendError(wsManager, ws, `Artifact "${msg.artifactId}" not found`)
        return true
      }
      if (artifact.type !== 'poll') {
        sendError(wsManager, ws, `Artifact "${msg.artifactId}" is not a poll`)
        return true
      }
      system.house.artifacts.update(
        msg.artifactId,
        { body: { castVote: msg.optionId } },
        { callerId: session.agent.id, callerName: session.agent.name },
      )
      return true
    }

    default:
      return false
  }
}
