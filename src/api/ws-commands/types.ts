import type { System } from '../../main.ts'
import type { ClientSession, WSManager } from '../ws-handler.ts'
import type { WSInbound, WSOutbound } from '../../core/types.ts'

export interface CommandContext {
  readonly ws: { send: (data: string) => void }
  readonly session: ClientSession
  readonly system: System
  readonly broadcast: (msg: WSOutbound) => void
  readonly wsManager: WSManager
}

export const sendError = (ws: { send: (data: string) => void }, message: string): void => {
  ws.send(JSON.stringify({ type: 'error', message } satisfies WSOutbound))
}

export const requireRoom = (ws: { send: (data: string) => void }, system: System, roomName: string): ReturnType<typeof system.house.getRoom> => {
  const room = system.house.getRoom(roomName)
  if (!room) sendError(ws, `Room "${roomName}" not found`)
  return room
}

export const requireAgent = (ws: { send: (data: string) => void }, system: System, agentName: string): ReturnType<typeof system.team.getAgent> => {
  const agent = system.team.getAgent(agentName)
  if (!agent) sendError(ws, `Agent "${agentName}" not found`)
  return agent
}

// A command handler returns true if it handled the message, false otherwise.
export type CommandHandler = (msg: WSInbound, ctx: CommandContext) => Promise<boolean> | boolean
