// UI-local view types, shared across render-*.ts modules. Minimal mirror of
// server-side types — widen to the full server type on the next refactor.

export interface UIMessage {
  id: string
  senderId: string
  senderName?: string   // forwarded from server Message; used as render fallback
                        // when the sender isn't in the local agents map (e.g.
                        // the local human before their AgentJoined snapshot).
  content: string
  timestamp: number
  type: string
  roomId?: string
  recipientId?: string
  generationMs?: number
  // Tokens/context metrics forwarded via server message metadata.
  promptTokens?: number
  completionTokens?: number
  contextMax?: number
  provider?: string
  model?: string
  // Error telemetry (set when type === 'error')
  errorCode?: string
  errorProvider?: string
  // Causality: which automation subsystem produced this message. Mirrors
  // server Message.cause; rendered as a small caption under the bubble.
  cause?: { kind: 'script' | 'scenario' | 'trigger'; name: string; step?: number }
}

export interface RoomProfile {
  id: string
  name: string
}

export interface AgentInfo {
  id: string
  name: string
  kind: string
  state: string
  model?: string
  context?: string
  tags?: ReadonlyArray<string>
}

