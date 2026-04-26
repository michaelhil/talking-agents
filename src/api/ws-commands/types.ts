import type { System } from '../../main.ts'
import type { ClientSession, WSManager, WSConnection } from '../ws-handler.ts'
import type { WSInbound, WSOutbound } from '../../core/types/ws-protocol.ts'

export interface CommandContext {
  // Widened from `{ send }` to the full WSConnection so command-handler
  // responses can route through wsManager.safeSend (backpressure check +
  // close on overflow). Bun's ServerWebSocket satisfies this shape.
  readonly ws: WSConnection
  readonly session: ClientSession
  readonly system: System
  readonly broadcast: (msg: WSOutbound) => void
  readonly wsManager: WSManager
}

// Helpers below take the full WSConnection so safeSend can be applied. The
// alternative — passing wsManager into every helper — proliferates parameters
// without adding clarity. WSConnection is the natural carrier.

export const sendError = (wsManager: WSManager, ws: WSConnection, message: string): void => {
  wsManager.safeSend(ws, JSON.stringify({ type: 'error', message } satisfies WSOutbound))
}

export const requireRoom = (wsManager: WSManager, ws: WSConnection, system: System, roomName: string): ReturnType<typeof system.house.getRoom> => {
  const room = system.house.getRoom(roomName)
  if (!room) sendError(wsManager, ws, `Room "${roomName}" not found`)
  return room
}

export const requireAgent = (wsManager: WSManager, ws: WSConnection, system: System, agentName: string): ReturnType<typeof system.team.getAgent> => {
  const agent = system.team.getAgent(agentName)
  if (!agent) sendError(wsManager, ws, `Agent "${agentName}" not found`)
  return agent
}

// A command handler returns true if it handled the message, false otherwise.
export type CommandHandler = (msg: WSInbound, ctx: CommandContext) => Promise<boolean> | boolean
