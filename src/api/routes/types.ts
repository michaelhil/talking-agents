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

// Distinct from reset: evict drops the System from in-memory state but
// leaves the on-disk snapshot intact. The next request lazy-reloads via
// restoreFromSnapshot, exercising the evict→reload boundary that the
// streaming-probe deploy gate uses to catch unsubscribeAgentState-style
// regressions.
export type EvictInstanceResult =
  | { readonly ok: true; readonly instanceId: string }
  | { readonly ok: false; readonly reason: string }

// Capabilities that the Instances admin routes need. Wired in bootstrap.ts.
export interface InstanceAdmin {
  readonly listOnDisk: () => Promise<ReadonlyArray<{ id: string; snapshotMtimeMs: number; snapshotSizeBytes: number }>>
  readonly liveIds: () => ReadonlySet<string>
  readonly createNew: () => Promise<{ id: string }>
  // Trash an instance directory by id. Refuses if id is the current cookie's
  // instance — caller should use /api/system/reset for that.
  readonly delete: (id: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  // Operator-initiated trash cleanup. Walks .trash/ and rm -rf each entry.
  readonly purgeTrash: () => Promise<{ purged: number; errors: ReadonlyArray<string> }>
  // Build a Set-Cookie value pointing at `id`. The route returns it on the response.
  readonly buildSwitchCookie: (id: string, req: Request) => string
}

// Read-only health snapshot used by /api/system/diagnostics. Walks the
// registry + wsManager to surface per-instance broadcast wiring state.
// Catches the silent-skip class of bug fixed in 5d73a8e: zero-broadcast
// instances under live traffic mean the wiring chain is broken somewhere.
export interface DiagnosticsCapability {
  readonly snapshot: () => {
    readonly instances: ReadonlyArray<{
      readonly id: string
      readonly wired: boolean
      readonly agentCount: number
      readonly lastBroadcastAt: number | null
    }>
    readonly wsSessions: number
  }
}

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
  // Drop the cookie's instance from memory without trashing its snapshot —
  // the next WS upgrade lazy-reloads via restoreFromSnapshot. Used by the
  // post-deploy streaming probe to exercise the evict→reload boundary.
  readonly evictInstance?: (req: Request) => Promise<EvictInstanceResult>
  // Instances admin (list / create / switch / delete). Wired in bootstrap.
  readonly instances?: InstanceAdmin
  // Read-only health/wiring snapshot. Wired in bootstrap.
  readonly diagnostics?: DiagnosticsCapability
}

export interface RouteEntry {
  readonly method: string
  readonly pattern: RegExp
  readonly handler: (req: Request, match: RegExpMatchArray, ctx: RouteContext) => Promise<Response> | Response
}
