// Wire-format mappers: server types (Message, AgentProfile, RoomProfile,
// Artifact) → UI types. Kept pure so ws-dispatch stays focused on routing,
// and so these can be unit-tested in isolation.

import type { UIMessage, RoomProfile, ArtifactInfo } from '../render-types.ts'
import type { Message, AgentProfile, RoomProfile as ServerRoomProfile } from '../../../core/types/messaging.ts'
import type { Artifact } from '../../../core/types/artifact.ts'
import type { AgentEntry } from '../stores.ts'

export const toUIMessage = (m: Message): UIMessage => ({
  id: m.id,
  senderId: m.senderId,
  ...(m.senderName !== undefined ? { senderName: m.senderName } : {}),
  content: m.content,
  timestamp: m.timestamp,
  type: m.type,
  roomId: m.roomId,
  generationMs: m.generationMs,
  ...(m.promptTokens !== undefined ? { promptTokens: m.promptTokens } : {}),
  ...(m.completionTokens !== undefined ? { completionTokens: m.completionTokens } : {}),
  ...(m.contextMax !== undefined ? { contextMax: m.contextMax } : {}),
  ...(m.provider !== undefined ? { provider: m.provider } : {}),
  ...(m.model !== undefined ? { model: m.model } : {}),
  ...(m.errorCode !== undefined ? { errorCode: m.errorCode } : {}),
  ...(m.errorProvider !== undefined ? { errorProvider: m.errorProvider } : {}),
})

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
