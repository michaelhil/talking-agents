import type { System } from '../../main.ts'
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
  readonly broadcast: (msg: WSOutbound) => void
  readonly broadcastToInstance?: (instanceId: string, msg: WSOutbound) => void
  readonly subscribeAgentState: (agentId: string, agentName: string) => void
  readonly unsubscribeAgentState?: (agentId: string) => void
  readonly remoteAddress?: string
  // Legacy whole-process reset (still used in single-tenant mode).
  readonly onResetCommit?: () => Promise<{ ok: true } | { ok: false; reason: string }>
  // Per-instance reset (Phase F5). Reads the cookie from req, evicts the
  // current instance, moves its files to .trash, returns a new id +
  // Set-Cookie header for the response.
  readonly resetInstance?: (req: Request) => Promise<ResetInstanceResult>
}

export interface RouteEntry {
  readonly method: string
  readonly pattern: RegExp
  readonly handler: (req: Request, match: RegExpMatchArray, ctx: RouteContext) => Promise<Response> | Response
}
