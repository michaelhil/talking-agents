import type { System } from '../../main.ts'
import type { Agent } from '../../core/types/agent.ts'
import type { WSOutbound } from '../../core/types/ws-protocol.ts'

export interface ResetInstanceOk {
  readonly ok: true
  readonly instanceId: string   // same id; the directory was moved to .trash and a fresh House will lazy-load
}
export interface ResetInstanceFail {
  readonly ok: false
  readonly reason: string
}
export type ResetInstanceResult = ResetInstanceOk | ResetInstanceFail

export interface RouteContext {
  readonly system: System
  // Instance bound to this request via the cookie (resolved before dispatch).
  readonly instanceId: string
  readonly broadcast: (msg: WSOutbound) => void
  readonly broadcastToInstance?: (instanceId: string, msg: WSOutbound) => void
  readonly subscribeAgentState: (agent: Agent, instanceId: string) => void
  readonly unsubscribeAgentState?: (agentId: string) => void
  readonly remoteAddress?: string
  // Per-instance reset (Phase F5). Reads the cookie from req, trashes the
  // instance directory, drops it from the registry. The same id is kept;
  // the next request from the same cookie lazy-creates a fresh empty House.
  readonly resetInstance?: (req: Request) => Promise<ResetInstanceResult>
}

export interface RouteEntry {
  readonly method: string
  readonly pattern: RegExp
  readonly handler: (req: Request, match: RegExpMatchArray, ctx: RouteContext) => Promise<Response> | Response
}
