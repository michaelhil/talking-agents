// WebSocket wire protocol — inbound (client → server) and outbound
// (server → client) message discriminated unions.

import type { Message, MessageTarget, RoomProfile, AgentProfile, DeliveryMode } from './messaging.ts'
import type { AIAgentConfig, StateValue } from './agent.ts'
import type { RoomState } from './room.ts'
import type { Artifact } from './artifact.ts'
import type { EvalEvent } from './agent-eval.ts'
import type { FlowEventDetails, FlowEventName } from './flow.ts'
import type { OllamaHealth, GatewayMetrics } from './llm.ts'

export type WSInbound =
  | { readonly type: 'post_message'; readonly target: MessageTarget; readonly content: string }
  | { readonly type: 'create_room'; readonly name: string; readonly roomPrompt?: string }
  | { readonly type: 'add_to_room'; readonly roomName: string; readonly agentName: string }
  | { readonly type: 'remove_from_room'; readonly roomName: string; readonly agentName: string }
  | { readonly type: 'create_agent'; readonly config: AIAgentConfig }
  | { readonly type: 'remove_agent'; readonly name: string }
  | { readonly type: 'update_agent'; readonly name: string; readonly systemPrompt?: string; readonly model?: string }
  // Delivery mode
  | { readonly type: 'set_delivery_mode'; readonly roomName: string; readonly mode: 'broadcast' }
  // Pause
  | { readonly type: 'set_paused'; readonly roomName: string; readonly paused: boolean }
  // Muting
  | { readonly type: 'set_muted'; readonly roomName: string; readonly agentName: string; readonly muted: boolean }
  // Flow execution (blueprint lives in artifacts; these commands control execution only)
  | { readonly type: 'start_flow'; readonly roomName: string; readonly flowArtifactId: string; readonly content: string }
  | { readonly type: 'cancel_flow'; readonly roomName: string }
  | { readonly type: 'cancel_generation'; readonly name: string }
  // Artifact management
  | { readonly type: 'add_artifact'; readonly artifactType: string; readonly title: string; readonly description?: string; readonly body: Record<string, unknown>; readonly scope?: ReadonlyArray<string> }
  | { readonly type: 'update_artifact'; readonly artifactId: string; readonly title?: string; readonly body?: Record<string, unknown>; readonly resolution?: string }
  | { readonly type: 'remove_artifact'; readonly artifactId: string }
  | { readonly type: 'cast_vote'; readonly artifactId: string; readonly optionId: string }
  // Room/message deletion
  | { readonly type: 'delete_room'; readonly roomName: string }
  | { readonly type: 'delete_message'; readonly roomName: string; readonly messageId: string }
  | { readonly type: 'clear_messages'; readonly roomName: string }

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
  | { readonly [E in FlowEventName]: { readonly type: 'flow_event'; readonly roomName: string; readonly event: E; readonly detail?: FlowEventDetails[E] } }[FlowEventName]
  | { readonly type: 'artifact_changed'; readonly action: 'added' | 'updated' | 'removed' | 'resolved'; readonly artifact: Artifact }
  | { readonly type: 'membership_changed'; readonly roomId: string; readonly roomName: string; readonly agentId: string; readonly agentName: string; readonly action: 'added' | 'removed' }
  | { readonly type: 'room_deleted'; readonly roomName: string }
  | { readonly type: 'message_deleted'; readonly roomName: string; readonly messageId: string }
  | { readonly type: 'messages_cleared'; readonly roomName: string }
  | { readonly type: 'ollama_health'; readonly health: OllamaHealth }
  | { readonly type: 'ollama_metrics'; readonly metrics: GatewayMetrics }
  | { readonly type: 'agent_activity'; readonly agentName: string; readonly event: EvalEvent }
  // Provider routing events (from src/llm/router.ts)
  | { readonly type: 'provider_bound'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly oldProvider: string | null; readonly newProvider: string }
  | { readonly type: 'provider_all_failed'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly attempts: ReadonlyArray<{ readonly provider: string; readonly reason: string }> }
  | { readonly type: 'provider_stream_failed'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly provider: string; readonly reason: string }
