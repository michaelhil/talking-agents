// Wire-format mappers: server types (Message, AgentProfile, RoomProfile,
// Artifact) → UI types. Kept pure so ws-dispatch stays focused on routing,
// and so these can be unit-tested in isolation.

import type { UIMessage, RoomProfile, ArtifactInfo } from '../render-types.ts'
import type { Message, AgentProfile, RoomProfile as ServerRoomProfile } from '../../../core/types/messaging.ts'
import type { Artifact } from '../../../core/types/artifact.ts'
import type { AgentEntry } from '../stores.ts'

export const toUIMessage = (m: Message): UIMessage => {
  const meta = (m.metadata ?? {}) as Record<string, unknown>
  return {
    id: m.id,
    senderId: m.senderId,
    content: m.content,
    timestamp: m.timestamp,
    type: m.type,
    roomId: m.roomId,
    generationMs: m.generationMs,
    ...(typeof meta.promptTokens === 'number' ? { promptTokens: meta.promptTokens } : {}),
    ...(typeof meta.completionTokens === 'number' ? { completionTokens: meta.completionTokens } : {}),
    ...(typeof meta.contextMax === 'number' ? { contextMax: meta.contextMax } : {}),
    ...(typeof meta.provider === 'string' ? { provider: meta.provider } : {}),
    ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
  }
}

export const toUIRoomProfile = (r: ServerRoomProfile): RoomProfile => ({
  id: r.id,
  name: r.name,
})

export const toAgentEntry = (a: AgentProfile): AgentEntry => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  model: a.model,
  state: 'idle',
})

export const toUIArtifact = (a: Artifact): ArtifactInfo => ({
  id: a.id,
  type: a.type,
  title: a.title,
  description: a.description,
  body: a.body,
  scope: a.scope,
  createdBy: a.createdBy,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  resolution: a.resolution,
  resolvedAt: a.resolvedAt,
})
