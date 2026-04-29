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

export interface TaskItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  assignee?: string
}

export interface PollOption {
  id: string
  text: string
  votes: ReadonlyArray<string>
}

export interface ArtifactInfo {
  id: string
  type: string
  title: string
  description?: string
  body: unknown
  scope: ReadonlyArray<string>
  createdBy: string
  createdAt: number
  updatedAt: number
  resolution?: string
  resolvedAt?: number
}

export type ArtifactAction =
  | { kind: 'add_task'; artifactId: string; content: string }
  | { kind: 'complete_task'; artifactId: string; taskId: string; completed: boolean }
  | { kind: 'cast_vote'; artifactId: string; optionId: string }
  | { kind: 'remove'; artifactId: string }
  | { kind: 'edit_document'; artifactId: string; title: string; blocks: ReadonlyArray<{ id: string; type: string; content: string }> }
