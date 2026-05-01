// Auto-select / GC for the per-room human poster.
//   - GC stale entries when the previously-selected agent was deleted.
//   - When exactly one human is a member of the room and no valid selection
//     exists, set them as the poster automatically.
// Subscribed from app.ts on $selectedRoomId changes and on $agents listen.

import { $agentListView, $selectedHumanByRoom } from './stores.ts'

export const reconcileSelectionForRoom = (roomId: string): void => {
  const posterMap = $selectedHumanByRoom.get()
  const view = $agentListView.get()
  const memberSet = new Set(view.roomMemberIds)
  const allAgents = view.agents

  const current = posterMap[roomId]
  const currentValid = current && allAgents[current] && allAgents[current].kind === 'human'
  if (!currentValid && current) {
    // Drop stale entry. setKey with undefined removes via the underlying map.
    const next = { ...posterMap }
    delete next[roomId]
    $selectedHumanByRoom.set(next)
  }
  if (currentValid) return

  const humansInRoom = Object.values(allAgents).filter(a => a.kind === 'human' && memberSet.has(a.id))
  if (humansInRoom.length === 1) {
    $selectedHumanByRoom.setKey(roomId, humansInRoom[0]!.id)
  }
}
