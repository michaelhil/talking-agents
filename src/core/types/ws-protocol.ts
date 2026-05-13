// WebSocket wire protocol — inbound (client → server) and outbound
// (server → client) message discriminated unions.

import type { Message, MessageTarget, RoomProfile, AgentProfile, DeliveryMode } from './messaging.ts'
import type { AIAgentConfig, IncludeContext, IncludePrompts, StateValue } from './agent.ts'
import type { RoomState, SummaryTarget } from './room.ts'
import type { EvalEvent } from './agent-eval.ts'
import type { OllamaHealth } from './llm.ts'
import type { SummaryConfig } from './summary.ts'

export type WSInbound =
  | { readonly type: 'post_message'; readonly target: MessageTarget; readonly content: string; readonly senderId?: string }
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
  // Room/message deletion
  | { readonly type: 'delete_room'; readonly roomName: string }
  | { readonly type: 'delete_message'; readonly roomName: string; readonly messageId: string }
  | { readonly type: 'clear_messages'; readonly roomName: string }
  // Summary + compression
  | { readonly type: 'set_summary_config'; readonly roomName: string; readonly config: SummaryConfig }
  | { readonly type: 'regenerate_summary'; readonly roomName: string; readonly target: 'summary' | 'compression' | 'both' }
  // Biometric capture lifecycle — samsinn-biometrics pack. All ephemeral.
  | { readonly type: 'biometric_capture_started'; readonly captureId: string }
  | { readonly type: 'biometric_capture_signal'; readonly captureId: string; readonly snapshot: BiometricSignalWire }
  | { readonly type: 'biometric_capture_stopped'; readonly captureId: string; readonly reason: 'user' | 'agent' | 'unmount' | 'disconnect' | 'error' }
  | { readonly type: 'biometric_capture_denied'; readonly captureId: string }
  | { readonly type: 'biometric_capture_failed'; readonly captureId: string; readonly error: string }

// Wire shape for biometric signal snapshots. Mirrors biometrics/types.ts
// BiometricSignal but duplicated here so the WS protocol module doesn't
// depend on the browser-only biometrics package.
export interface BiometricSignalWire {
  readonly ts: number
  readonly presence: boolean
  readonly faceCount: number
  readonly attention: number
  readonly expression: { readonly smile: number; readonly surprise: number; readonly frown: number; readonly concentration: number }
  readonly headPose: { readonly yaw: number; readonly pitch: number; readonly roll: number }
  readonly blinkRate: number
}

export type WSOutbound =
  | { readonly type: 'message'; readonly message: Message }
  | { readonly type: 'agent_state'; readonly agentName: string; readonly state: StateValue; readonly context?: string; readonly generationStarted?: number }
  | { readonly type: 'room_created'; readonly profile: RoomProfile }
  | { readonly type: 'agent_joined'; readonly agent: AgentProfile }
  | { readonly type: 'agent_removed'; readonly agentName: string }
  | { readonly type: 'agent_renamed'; readonly id: string; readonly oldName: string; readonly newName: string }
  | { readonly type: 'snapshot'; readonly rooms: ReadonlyArray<RoomProfile>; readonly agents: ReadonlyArray<AgentProfile>; readonly agentId?: string; readonly roomStates?: Record<string, RoomState>; readonly sessionToken?: string }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'delivery_mode_changed'; readonly roomName: string; readonly mode: DeliveryMode; readonly paused: boolean }
  | { readonly type: 'mute_changed'; readonly roomName: string; readonly agentName: string; readonly muted: boolean }
  | { readonly type: 'turn_changed'; readonly roomName: string; readonly agentName?: string; readonly waitingForHuman?: boolean }
  | { readonly type: 'membership_changed'; readonly roomId: string; readonly roomName: string; readonly agentId: string; readonly agentName: string; readonly action: 'added' | 'removed' }
  | { readonly type: 'room_deleted'; readonly roomName: string }
  | { readonly type: 'message_deleted'; readonly roomName: string; readonly messageId: string }
  | { readonly type: 'messages_cleared'; readonly roomName: string }
  | { readonly type: 'activation_result'; readonly roomName: string; readonly agentName: string; readonly ok: boolean; readonly queued: boolean; readonly reason?: string }
  | { readonly type: 'mode_auto_switched'; readonly roomName: string; readonly toMode: DeliveryMode; readonly reason: 'second-ai-joined' }
  // Script runner events (v2)
  | { readonly type: 'script_started'; readonly roomName: string; readonly scriptId: string; readonly scriptName: string; readonly title: string; readonly premise?: string; readonly totalSteps: number; readonly stepTitle: string; readonly cast: ReadonlyArray<{ readonly id: string; readonly name: string; readonly model: string; readonly kind: 'ai'; readonly persona: string; readonly starts: boolean }>; readonly steps: ReadonlyArray<{ readonly title: string; readonly goal?: string; readonly roles: Readonly<Record<string, string>> }> }
  | { readonly type: 'script_step_advanced'; readonly roomName: string; readonly scriptId: string; readonly stepIndex: number; readonly totalSteps: number; readonly title: string; readonly forced?: boolean }
  | { readonly type: 'script_readiness_changed'; readonly roomName: string; readonly scriptId: string; readonly readiness: Readonly<Record<string, boolean>>; readonly readyStreak: Readonly<Record<string, number>>; readonly whisperFailures: number; readonly lastWhisper: Readonly<Record<string, { readonly turn: number; readonly whisper: { readonly ready_to_advance: boolean; readonly notes?: string; readonly addressing?: string; readonly role_update?: string }; readonly usedFallback: boolean; readonly rawResponse?: string; readonly errorReason?: string }>> }
  | { readonly type: 'script_dialogue_appended'; readonly roomName: string; readonly scriptId: string; readonly stepIndex: number; readonly entry: { readonly speaker: string; readonly content: string; readonly messageId: string; readonly whispersByCast: Readonly<Record<string, { readonly turn: number; readonly whisper: { readonly ready_to_advance: boolean; readonly notes?: string; readonly addressing?: string; readonly role_update?: string }; readonly usedFallback: boolean; readonly rawResponse?: string; readonly errorReason?: string }>> } }
  | { readonly type: 'script_completed'; readonly roomName: string; readonly scriptId: string }
  | { readonly type: 'script_catalog_changed' }
  | { readonly type: 'ollama_health'; readonly health: OllamaHealth }
  | { readonly type: 'agent_activity'; readonly agentName: string; readonly event: EvalEvent }
  // Provider routing events (from src/llm/router.ts)
  | { readonly type: 'provider_bound'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly oldProvider: string | null; readonly newProvider: string }
  | { readonly type: 'provider_stream_failed'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly provider: string; readonly reason: string }
  // Fired after the providers admin endpoint applies a live key change. UI
  // listeners refresh their model-list dropdowns without a reload.
  | { readonly type: 'providers_changed'; readonly providers: ReadonlyArray<string> }
  // Fired after a pack is installed / updated / uninstalled. UI panels refresh.
  | { readonly type: 'packs_changed' }
  // Fired after a room's activePacks list is replaced. UI updates the
  // active-packs panel for that room without a full refetch.
  | { readonly type: 'pack_activation_changed'; readonly roomId: string; readonly activePacks: ReadonlyArray<string> }
  // (`wiki_changed` removed in commit M — wiki lifecycle now rides on
  // `packs_changed` since wikis are pack-bundled.)
  // Fired after an agent's trigger is created/updated/deleted. UI re-fetches
  // the trigger list. The scheduler itself doesn't broadcast on fire — fired
  // triggers post to the room and surface as a normal `message.posted` event.
  | {
      readonly type: 'triggers_changed'
      readonly agentId: string
      readonly triggerId?: string
      readonly action: 'created' | 'updated' | 'deleted'
    }
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
  // RAG documents — fired on every status transition (pending → indexed/failed)
  // so the UI can refresh the corpus list without polling.
  | {
      readonly type: 'document_status'
      readonly docId: string
      readonly filename: string
      readonly status: 'pending' | 'indexed' | 'failed'
      readonly errorMessage?: string
      readonly chunkCount?: number
      readonly pageCount?: number
    }
  // Biometric capture: another tab claimed the captureId first. Late tabs
  // swap their pending widget to a "active in another tab" placeholder and
  // release any MediaStream they had opened.
  | { readonly type: 'biometric_capture_claimed'; readonly captureId: string; readonly claimedBy: string }
  // Agent has called biometrics_stop while a widget is still streaming.
  // Live widget releases its MediaStream and renders the terminal summary.
  // Distinct from biometric_capture_stopped (UI→server) which the widget
  // itself sends on user-driven teardown.
  | { readonly type: 'biometric_capture_stop_requested'; readonly captureId: string; readonly reason: 'agent' }
