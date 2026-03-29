// Shared room resolver for built-in tool implementations.
// Falls back to the current room from ToolContext if no roomName param provided.

import type { House, Room, ToolContext } from '../../core/types.ts'

export const resolveRoom = (house: House, params: Record<string, unknown>, context: ToolContext): Room | undefined => {
  const name = params.roomName as string | undefined
  if (name) return house.getRoom(name)
  if (context.roomId) return house.getRoom(context.roomId)
  return undefined
}
