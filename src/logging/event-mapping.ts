// ============================================================================
// Event mapping — translate samsinn's typed late-bound callback args into
// the unified `LogEvent` envelope.
//
// Pure functions. Each `mk<Kind>` takes the native callback args and returns
// a LogEvent. Callers supply the active `sessionId`. Kept here (not inlined
// in `main.ts`) so we can test the translation without spinning up a System.
//
// Choice of which callbacks to log:
//   INCLUDED — messagePosted, deliveryModeChanged, modeAutoSwitched,
//              artifactChanged, roomCreated, roomDeleted, membershipChanged,
//              evalEvent, providerBound, providerAllFailed, providerStreamFailed,
//              summaryConfigChanged, summaryUpdated, summaryRunStarted,
//              summaryRunCompleted, summaryRunFailed
//   EXCLUDED — turnChanged (fires too often; every eval tick), bookmarksChanged
//              (UI concern), summaryRunDelta (per-chunk token noise)
//   Decisions revisable via SAMSINN_LOG_KINDS env var — filter is applied
//   OUTSIDE this module, in the bootstrap wiring.
// ============================================================================

import type { Artifact } from '../core/types/artifact.ts'
import type { DeliveryMode, Message, RoomProfile } from '../core/types/messaging.ts'
import type { EvalEvent } from '../core/types/agent-eval.ts'
import type { SummaryTarget } from '../core/types/room.ts'
import type { SummaryConfig } from '../core/types/summary.ts'
import type { ProviderAttempt, ProviderAllFailedSummary } from '../core/types/llm.ts'
import type { LogActor, LogEvent } from './types.ts'

// --- actor constructors ---

const senderActor = (m: Message): LogActor | undefined =>
  m.senderName !== undefined
    ? { kind: m.senderId?.startsWith('agent-') ? 'ai' : 'unknown', id: m.senderId, name: m.senderName }
    : m.senderId !== undefined
      ? { kind: 'unknown', id: m.senderId }
      : undefined

const systemActor: LogActor = { kind: 'system' }

// --- per-kind constructors ---

export const mkMessagePosted = (sessionId: string, roomId: string, message: Message): LogEvent => ({
  ts: message.timestamp,
  kind: 'message.posted',
  session: sessionId,
  roomId,
  ...(senderActor(message) ? { actor: senderActor(message)! } : {}),
  payload: { message },
})

export const mkDeliveryModeChanged = (sessionId: string, roomId: string, mode: DeliveryMode): LogEvent => ({
  ts: Date.now(),
  kind: 'room.delivery_mode_changed',
  session: sessionId,
  roomId,
  actor: systemActor,
  payload: { mode },
})

export const mkModeAutoSwitched = (sessionId: string, roomId: string, toMode: DeliveryMode, reason: string): LogEvent => ({
  ts: Date.now(),
  kind: 'room.mode_auto_switched',
  session: sessionId,
  roomId,
  actor: systemActor,
  payload: { toMode, reason },
})

export const mkRoomCreated = (sessionId: string, profile: RoomProfile): LogEvent => ({
  ts: Date.now(),
  kind: 'room.created',
  session: sessionId,
  roomId: profile.id,
  actor: systemActor,
  payload: { profile },
})

export const mkRoomDeleted = (sessionId: string, roomId: string, roomName: string): LogEvent => ({
  ts: Date.now(),
  kind: 'room.deleted',
  session: sessionId,
  roomId,
  actor: systemActor,
  payload: { roomName },
})

export const mkMembershipChanged = (
  sessionId: string,
  roomId: string, roomName: string, agentId: string, agentName: string, action: 'added' | 'removed',
): LogEvent => ({
  ts: Date.now(),
  kind: 'room.membership_changed',
  session: sessionId,
  roomId,
  actor: { kind: 'unknown', id: agentId, name: agentName },
  payload: { roomName, agentId, agentName, action },
})

export const mkArtifactChanged = (
  sessionId: string,
  action: 'added' | 'updated' | 'removed' | 'resolved', artifact: Artifact,
): LogEvent => ({
  ts: Date.now(),
  kind: 'artifact.changed',
  session: sessionId,
  ...(artifact.scope.length > 0 ? { roomId: artifact.scope[0] } : {}),
  payload: { action, artifact },
})

export const mkEvalEvent = (sessionId: string, agentName: string, event: EvalEvent): LogEvent => ({
  ts: Date.now(),
  kind: 'agent.eval_event',
  session: sessionId,
  actor: { kind: 'ai', name: agentName },
  payload: { event },
})

export const mkProviderBound = (
  sessionId: string,
  agentId: string | null, model: string, oldProvider: string | null, newProvider: string,
): LogEvent => ({
  ts: Date.now(),
  kind: 'provider.bound',
  session: sessionId,
  ...(agentId ? { actor: { kind: 'ai' as const, id: agentId } } : {}),
  payload: { model, oldProvider, newProvider },
})

export const mkProviderAllFailed = (
  sessionId: string,
  agentId: string | null, model: string, attempts: ReadonlyArray<ProviderAttempt>,
  summary: ProviderAllFailedSummary,
): LogEvent => ({
  ts: Date.now(),
  kind: 'provider.all_failed',
  session: sessionId,
  ...(agentId ? { actor: { kind: 'ai' as const, id: agentId } } : {}),
  payload: { model, attempts, ...summary },
})

export const mkProviderStreamFailed = (
  sessionId: string,
  agentId: string | null, model: string, provider: string, reason: string,
): LogEvent => ({
  ts: Date.now(),
  kind: 'provider.stream_failed',
  session: sessionId,
  ...(agentId ? { actor: { kind: 'ai' as const, id: agentId } } : {}),
  payload: { model, provider, reason },
})

export const mkSummaryConfigChanged = (sessionId: string, roomId: string, config: SummaryConfig): LogEvent => ({
  ts: Date.now(),
  kind: 'summary.config_changed',
  session: sessionId,
  roomId,
  payload: { config },
})

export const mkSummaryUpdated = (sessionId: string, roomId: string, target: SummaryTarget): LogEvent => ({
  ts: Date.now(),
  kind: 'summary.updated',
  session: sessionId,
  roomId,
  payload: { target },
})

export const mkSummaryRunStarted = (sessionId: string, roomId: string, target: SummaryTarget): LogEvent => ({
  ts: Date.now(),
  kind: 'summary.run_started',
  session: sessionId,
  roomId,
  payload: { target },
})

export const mkSummaryRunCompleted = (sessionId: string, roomId: string, target: SummaryTarget, text: string): LogEvent => ({
  ts: Date.now(),
  kind: 'summary.run_completed',
  session: sessionId,
  roomId,
  payload: { target, text },
})

export const mkSummaryRunFailed = (sessionId: string, roomId: string, target: SummaryTarget, reason: string): LogEvent => ({
  ts: Date.now(),
  kind: 'summary.run_failed',
  session: sessionId,
  roomId,
  payload: { target, reason },
})

// --- synthetic events (not callback-backed) ---

export const mkSessionStart = (sessionId: string, config: Record<string, unknown>): LogEvent => ({
  ts: Date.now(),
  kind: 'session.start',
  session: sessionId,
  actor: systemActor,
  payload: { config },
})

export const mkSessionEnd = (sessionId: string, reason: string): LogEvent => ({
  ts: Date.now(),
  kind: 'session.end',
  session: sessionId,
  actor: systemActor,
  payload: { reason },
})
