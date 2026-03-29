import type { System } from '../../../main.ts'
import type { Room, Agent } from '../../../core/types.ts'

export const textResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
})

export const errorResult = (message: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  isError: true as const,
})

export const resolveRoom = (system: System, roomName: string): Room => {
  const room = system.house.getRoom(roomName)
  if (!room) throw new Error(`Room "${roomName}" not found`)
  return room
}

export const resolveAgent = (system: System, agentName: string): Agent => {
  const agent = system.team.getAgent(agentName)
  if (!agent) throw new Error(`Agent "${agentName}" not found`)
  return agent
}
