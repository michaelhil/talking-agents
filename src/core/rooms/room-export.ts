// ============================================================================
// Room export — structured conversation snapshot for scripted runs.
//
// Returns every message in a room with its full telemetry (tokens, provider,
// model, generationMs, etc.) in a deterministic JSON shape. Used by the
// `export_room` MCP tool and the `GET /api/rooms/:id/export` REST route.
//
// Deliberately minimal: messages are passed through unchanged. Any future
// fields added to Message flow into exports automatically — experiments want
// that, not a frozen schema.
// ============================================================================

import type { Message } from '../types/messaging.ts'
import type { Room } from '../types/room.ts'

export interface RoomExport {
  readonly roomId: string
  readonly roomName: string
  readonly exportedAt: number
  readonly messageCount: number
  readonly messages: ReadonlyArray<Message>
}

// Pulling "all messages" from a room uses getRecent with a very large N.
// Room message arrays are in-memory and bounded by snapshot/compression; this
// is cheap even for the longest realistic conversation.
const ALL = Number.MAX_SAFE_INTEGER

export const exportRoomConversation = (room: Room): RoomExport => {
  const messages = room.getRecent(ALL)
  return {
    roomId: room.profile.id,
    roomName: room.profile.name,
    exportedAt: Date.now(),
    messageCount: messages.length,
    messages,
  }
}
