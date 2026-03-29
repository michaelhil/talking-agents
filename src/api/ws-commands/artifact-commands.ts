import type { Artifact, FlowArtifactBody, FlowStep, WSInbound } from '../../core/types.ts'
import { requireRoom, sendError, type CommandContext } from './types.ts'

export const handleArtifactCommand = (msg: WSInbound, ctx: CommandContext): boolean => {
  const { ws, session, system } = ctx

  switch (msg.type) {
    case 'add_artifact': {
      const typeDef = system.house.artifactTypes.get(msg.artifactType)
      if (!typeDef) {
        sendError(ws, `Unknown artifact type "${msg.artifactType}"`)
        return true
      }
      // Resolve scope: room names → IDs
      const scope: string[] = []
      if (msg.scope) {
        for (const name of msg.scope) {
          const room = system.house.getRoom(name)
          if (!room) {
            sendError(ws, `Room "${name}" not found`)
            return true
          }
          scope.push(room.profile.id)
        }
      }
      system.house.artifacts.add({
        type: msg.artifactType,
        title: msg.title,
        body: msg.body,
        scope,
        createdBy: session.agent.name,
      })
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
      if (!updated) sendError(ws, `Artifact "${msg.artifactId}" not found`)
      return true
    }

    case 'remove_artifact': {
      const removed = system.house.artifacts.remove(msg.artifactId)
      if (!removed) sendError(ws, `Artifact "${msg.artifactId}" not found`)
      return true
    }

    case 'cast_vote': {
      const artifact = system.house.artifacts.get(msg.artifactId)
      if (!artifact) {
        sendError(ws, `Artifact "${msg.artifactId}" not found`)
        return true
      }
      if (artifact.type !== 'poll') {
        sendError(ws, `Artifact "${msg.artifactId}" is not a poll`)
        return true
      }
      system.house.artifacts.update(
        msg.artifactId,
        { body: { castVote: msg.optionId } },
        { callerId: session.agent.id, callerName: session.agent.name },
      )
      return true
    }

    case 'start_flow': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true

      const artifact = system.house.artifacts.get(msg.flowArtifactId)
      if (!artifact || artifact.type !== 'flow') {
        sendError(ws, `Flow artifact "${msg.flowArtifactId}" not found`)
        return true
      }
      const flowBody = artifact.body as FlowArtifactBody
      // Resolve any steps missing agentId (forward-compat with old data)
      const steps: FlowStep[] = (flowBody.steps ?? []).map(s => ({
        agentId: s.agentId || (system.team.getAgent(s.agentName)?.id ?? ''),
        agentName: s.agentName,
        ...(s.stepPrompt ? { stepPrompt: s.stepPrompt } : {}),
      }))

      if (steps.length === 0) {
        sendError(ws, 'Flow has no steps')
        return true
      }

      const unresolvedStep = steps.find(s => !s.agentId)
      if (unresolvedStep) {
        sendError(ws, `Flow step agent "${unresolvedStep.agentName}" not found`)
        return true
      }

      room.setPaused(true)
      room.post({
        senderId: session.agent.id,
        senderName: session.agent.name,
        content: msg.content,
        type: 'chat',
      })
      room.startFlow({
        id: artifact.id,
        name: artifact.title,
        steps,
        loop: flowBody.loop ?? false,
      })
      return true
    }

    case 'cancel_flow': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      room.cancelFlow()
      return true
    }

    default:
      return false
  }
}
