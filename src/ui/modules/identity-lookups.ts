// Agent/room name ↔ id accessors that read from the current store state.
// Thin wrappers kept in one file so callers don't have to import the stores
// directly.

import { $agentIdByName, $roomIdByName, $agents, $rooms } from './stores.ts'

/** Agent name → agent ID (via computed store). */
export const agentNameToId = (name: string): string | undefined =>
  $agentIdByName.get()[name]

/** Room name → room ID (via computed store). */
export const roomNameToId = (name: string): string | undefined =>
  $roomIdByName.get()[name]

/** Agent ID → agent name. */
export const agentIdToName = (id: string): string | undefined =>
  $agents.get()[id]?.name

/** Room ID → room name. */
export const roomIdToName = (id: string): string | undefined =>
  $rooms.get()[id]?.name
