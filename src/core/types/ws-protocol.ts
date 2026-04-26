// WebSocket wire protocol — inbound (client → server) and outbound
// (server → client) message discriminated unions.

import type { Message, MessageTarget, RoomProfile, AgentProfile, DeliveryMode } from './messaging.ts'
import type { AIAgentConfig, IncludeContext, IncludePrompts, StateValue } from './agent.ts'
import type { RoomState, SummaryTarget } from './room.ts'
import type { Artifact } from './artifact.ts'
import type { EvalEvent } from './agent-eval.ts'
import type { OllamaHealth, GatewayMetrics } from './llm.ts'
import type { SummaryConfig } from './summary.ts'

export type WSInbound =
  | { readonly type: 'post_message'; readonly target: MessageTarget; readonly content: string }
  | { readonly type: 'create_room'; readonly name: string; readonly roomPrompt?: string }
  | { readonly type: 'add_to_room'; readonly roomName: string; readonly agentName: string }
  | { readonly type: 'remove_from_room'; readonly roomName: string; readonly agentName: string }
  | { readonly type: 'create_agent'; readonly config: AIAgentConfig }
  | { readonly type: 'remove_agent'; readonly name: string }
  | {
      readonly type: 'update_agent'
      readonly name: string
      readonly persona?: string
      readonly model?: string
      readonly includePrompts?: IncludePrompts
      readonly includeContext?: IncludeContext
      readonly includeTools?: boolean
      readonly maxToolResultChars?: number | null
      readonly maxToolIterations?: number
      readonly tools?: ReadonlyArray<string>
    }
  // Delivery mode
  | { readonly type: 'set_delivery_mode'; readonly roomName: string; readonly mode: 'broadcast' | 'manual' }
  | { readonly type: 'activate_agent'; readonly roomName: string; readonly agentName: string }
  // Pause
  | { readonly type: 'set_paused'; readonly roomName: string; readonly paused: boolean }
  // Muting
  | { readonly type: 'set_muted'; readonly roomName: string; readonly agentName: string; readonly muted: boolean }
  | { readonly type: 'cancel_generation'; readonly name: string }
  // Artifact management
  | { readonly type: 'add_artifact'; readonly artifactType: string; readonly title: string; readonly description?: string; readonly body: Record<string, unknown>; readonly scope?: ReadonlyArray<string>; readonly requestId?: string }
  | { readonly type: 'update_artifact'; readonly artifactId: string; readonly title?: string; readonly body?: Record<string, unknown>; readonly resolution?: string }
  | { readonly type: 'remove_artifact'; readonly artifactId: string }
  | { readonly type: 'cast_vote'; readonly artifactId: string; readonly optionId: string }
  // Room/message deletion
  | { readonly type: 'delete_room'; readonly roomName: string }
  | { readonly type: 'delete_message'; readonly roomName: string; readonly messageId: string }
  | { readonly type: 'clear_messages'; readonly roomName: string }
  // Summary + compression
  | { readonly type: 'set_summary_config'; readonly roomName: string; readonly config: SummaryConfig }
  | { readonly type: 'regenerate_summary'; readonly roomName: string; readonly target: 'summary' | 'compression' | 'both' }

export type WSOutbound =
  | { readonly type: 'message'; readonly message: Message }
  | { readonly type: 'agent_state'; readonly agentName: string; readonly state: StateValue; readonly context?: string }
  | { readonly type: 'room_created'; readonly profile: RoomProfile }
  | { readonly type: 'agent_joined'; readonly agent: AgentProfile }
  | { readonly type: 'agent_removed'; readonly agentName: string }
  | { readonly type: 'snapshot'; readonly rooms: ReadonlyArray<RoomProfile>; readonly agents: ReadonlyArray<AgentProfile>; readonly agentId: string; readonly roomStates?: Record<string, RoomState>; readonly sessionToken?: string }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'delivery_mode_changed'; readonly roomName: string; readonly mode: DeliveryMode; readonly paused: boolean }
  | { readonly type: 'mute_changed'; readonly roomName: string; readonly agentName: string; readonly muted: boolean }
  | { readonly type: 'turn_changed'; readonly roomName: string; readonly agentName?: string; readonly waitingForHuman?: boolean }
  | { readonly type: 'artifact_changed'; readonly action: 'added' | 'updated' | 'removed' | 'resolved'; readonly artifact: Artifact }
  | { readonly type: 'membership_changed'; readonly roomId: string; readonly roomName: string; readonly agentId: string; readonly agentName: string; readonly action: 'added' | 'removed' }
  | { readonly type: 'room_deleted'; readonly roomName: string }
  | { readonly type: 'message_deleted'; readonly roomName: string; readonly messageId: string }
  | { readonly type: 'messages_cleared'; readonly roomName: string }
  | { readonly type: 'activation_result'; readonly roomName: string; readonly agentName: string; readonly ok: boolean; readonly queued: boolean; readonly reason?: string }
  | { readonly type: 'mode_auto_switched'; readonly roomName: string; readonly toMode: DeliveryMode; readonly reason: 'second-ai-joined' }
  // Directed reply to the client that sent add_artifact with a requestId.
  | { readonly type: 'artifact_created'; readonly requestId: string; readonly artifactId: string; readonly artifactType: string }
  | { readonly type: 'ollama_health'; readonly health: OllamaHealth }
  | { readonly type: 'ollama_metrics'; readonly metrics: GatewayMetrics }
  | { readonly type: 'agent_activity'; readonly agentName: string; readonly event: EvalEvent }
  // Provider routing events (from src/llm/router.ts)
  | { readonly type: 'provider_bound'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly oldProvider: string | null; readonly newProvider: string }
  | { readonly type: 'provider_all_failed'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly attempts: ReadonlyArray<{ readonly provider: string; readonly reason: string }> }
  | { readonly type: 'provider_stream_failed'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly provider: string; readonly reason: string }
  // Fired after the providers admin endpoint applies a live key change. UI
  // listeners refresh their model-list dropdowns without a reload.
  | { readonly type: 'providers_changed'; readonly providers: ReadonlyArray<string> }
  // Fired after a pack is installed / updated / uninstalled. UI panels refresh.
  | { readonly type: 'packs_changed' }
  // Sandbox reset lifecycle. `commitsAtMs` is an absolute epoch ms — UI
  // computes its own countdown (no clock-skew handshake needed for ±1 s).
  | { readonly type: 'reset_pending'; readonly commitsAtMs: number }
  | { readonly type: 'reset_cancelled' }
  | { readonly type: 'reset_failed'; readonly reason: string }
  // Per-instance reset committed. Browser should reload — its cookie has
  // already been swapped via Set-Cookie on the same response that started
  // the countdown. Old WS connections close on next eviction sweep.
  | { readonly type: 'reset_committed'; readonly oldId: string; readonly newId: string }
  // Summary + compression
  | { readonly type: 'summary_config_changed'; readonly roomName: string; readonly config: SummaryConfig }
  | { readonly type: 'summary_run_started'; readonly roomName: string; readonly target: SummaryTarget }
  | { readonly type: 'summary_run_delta'; readonly roomName: string; readonly target: SummaryTarget; readonly delta: string }
  | { readonly type: 'summary_run_completed'; readonly roomName: string; readonly target: SummaryTarget; readonly text: string }
  | { readonly type: 'summary_run_failed'; readonly roomName: string; readonly target: SummaryTarget; readonly reason: string }
