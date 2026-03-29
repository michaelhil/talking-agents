import type { System } from '../../main.ts'
import type { WSOutbound } from '../../core/types.ts'

export interface RouteContext {
  readonly system: System
  readonly broadcast: (msg: WSOutbound) => void
  readonly subscribeAgentState: (agentId: string, agentName: string) => void
  readonly unsubscribeAgentState?: (agentId: string) => void
}

export interface RouteEntry {
  readonly method: string
  readonly pattern: RegExp
  readonly handler: (req: Request, match: RegExpMatchArray, ctx: RouteContext) => Promise<Response> | Response
}
