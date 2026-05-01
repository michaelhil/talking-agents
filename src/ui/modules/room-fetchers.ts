// ============================================================================
// Room-data fetchers — HTTP GET for the three per-room collections that
// populate on room selection (messages, members, artifacts).
//
// Each function writes into the appropriate nanostore. Failures log to
// console.error via safeFetchJson — acceptable noise for room-data fetches
// that may race with room deletion on the server.
// ============================================================================

import { safeFetchJson } from './fetch-helpers.ts'
import { $roomMessages, $roomMembers, $artifacts } from './stores.ts'
import type { RoomProfile, UIMessage, ArtifactInfo } from './render/render-types.ts'

export const fetchRoomMessages = async (_roomId: string, roomName: string): Promise<void> => {
  const data = await safeFetchJson<{ profile: RoomProfile; messages: UIMessage[] }>(
    `/api/rooms/${encodeURIComponent(roomName)}?limit=50`,
  )
  if (!data) return
  $roomMessages.setKey(data.profile.id, data.messages)
}

export const fetchRoomMembers = async (roomId: string, roomName: string): Promise<void> => {
  const members = await safeFetchJson<Array<{ id: string }>>(
    `/api/rooms/${encodeURIComponent(roomName)}/members`,
  )
  if (!members) return
  $roomMembers.setKey(roomId, members.map(m => m.id))
}

export const fetchRoomArtifacts = async (_roomId: string, roomName: string): Promise<void> => {
  const artifacts = await safeFetchJson<ArtifactInfo[]>(
    `/api/rooms/${encodeURIComponent(roomName)}/artifacts`,
  )
  if (!artifacts) return
  for (const a of artifacts) $artifacts.setKey(a.id, a)
}
