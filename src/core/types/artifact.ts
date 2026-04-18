// Artifact system — system-level collaborative objects (task lists, polls,
// flow blueprints, documents). Artifacts live in House and are scoped to
// rooms via `scope`. The type system mirrors the Tool plugin pattern.

import type { FlowStep } from './flow.ts'
import type { ToolContext } from './tool.ts'

// === Embedded task item within a task_list artifact ===

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface TaskItem {
  readonly id: string                          // local UUID within the list
  readonly content: string
  readonly status: TaskStatus
  readonly assignee?: string                   // agent name
  readonly assigneeId?: string                 // agent UUID
  readonly result?: string                     // resolution comment when completed
  readonly dependencies?: ReadonlyArray<string>  // other TaskItem ids within same list
  readonly createdBy: string                   // agent name
  readonly createdAt: number
  readonly updatedAt: number
}

// === Built-in artifact body types ===

export interface TaskListBody {
  readonly description?: string
  readonly tasks: ReadonlyArray<TaskItem>
}

export interface PollOption {
  readonly id: string
  readonly text: string
}

export interface PollBody {
  readonly question: string
  readonly options: ReadonlyArray<PollOption>   // immutable after creation
  readonly votes: Record<string, ReadonlyArray<string>>  // optionId → agentId[]
  readonly allowMultiple: boolean
}

export interface FlowArtifactBody {
  readonly steps: ReadonlyArray<FlowStep>
  readonly loop: boolean
  readonly description?: string
}

// === Document artifact body types ===

export type BlockType = 'heading1' | 'heading2' | 'heading3' | 'paragraph' | 'code' | 'quote' | 'list'

export interface DocumentBlock {
  readonly id: string          // stable UUID — safe for concurrent insert/delete
  readonly type: BlockType
  readonly content: string
}

export interface DocumentBody {
  readonly blocks: ReadonlyArray<DocumentBlock>
}

export interface MermaidBody {
  readonly source: string
}

// Union of all built-in artifact body shapes. Plugin-defined artifact types
// fall outside this union; callers with a dynamic type name should narrow by
// inspecting `artifact.type` and casting the body, or pattern-match here.
export type ArtifactBody = TaskListBody | PollBody | FlowArtifactBody | DocumentBody | MermaidBody

// === Artifact instance ===

export interface Artifact {
  readonly id: string
  readonly type: string                         // artifact type name: 'task_list', 'poll', 'flow'
  readonly title: string                        // human-readable label
  readonly description?: string                 // optional longer description
  readonly body: Record<string, unknown>        // type-specific payload
  readonly scope: ReadonlyArray<string>         // room IDs; empty = system-wide
  readonly createdBy: string                    // agent name
  readonly createdAt: number
  readonly updatedAt: number
  readonly resolution?: string                  // how/why it was resolved
  readonly resolvedAt?: number                  // timestamp of resolution
}

export interface ArtifactCreateConfig {
  readonly type: string
  readonly title: string
  readonly description?: string
  readonly body: Record<string, unknown>
  readonly scope?: ReadonlyArray<string>        // defaults to []
  readonly createdBy: string
}

export interface ArtifactUpdateConfig {
  readonly title?: string
  readonly description?: string
  readonly body?: Record<string, unknown>       // type's onUpdate decides merge strategy; default: shallow merge
  readonly resolution?: string                  // explicit resolution
}

// Returned by ArtifactTypeDefinition.onUpdate — overrides default shallow merge
export interface ArtifactUpdateResult {
  readonly newBody?: Record<string, unknown>    // replaces body if provided; if absent, default merge applies
  readonly resolution?: string                  // auto-resolves if set
}

// === Artifact type definition (plugin contract, mirrors Tool) ===
// Types that need dependencies (ArtifactStore, Team) are factory functions injected at registration.

export interface ArtifactTypeDefinition {
  readonly type: string
  readonly description: string
  readonly bodySchema: Record<string, unknown>  // JSON Schema for body — used in tool parameters
  // Lifecycle hooks — all optional
  readonly onCreate?: (artifact: Artifact, ctx: ToolContext) => void
  readonly onUpdate?: (artifact: Artifact, updates: ArtifactUpdateConfig, ctx: ToolContext) => ArtifactUpdateResult | void
  readonly onRemove?: (artifact: Artifact) => void
  readonly checkAutoResolve?: (artifact: Artifact) => string | undefined
  // LLM context rendering — optional; generic fallback used if absent
  readonly formatForContext?: (artifact: Artifact) => string
  // Custom update notification message — called when action is 'updated' and type opts in
  readonly formatUpdateMessage?: (artifact: Artifact) => string | undefined
  // Controls when a system message is posted to scoped rooms on change
  // Include 'updated' to opt into blackboard update notifications
  readonly postSystemMessageOn?: ReadonlyArray<'added' | 'updated' | 'removed' | 'resolved'>
}

export interface ArtifactTypeRegistry {
  readonly register: (def: ArtifactTypeDefinition) => void
  readonly get: (type: string) => ArtifactTypeDefinition | undefined
  readonly list: () => ReadonlyArray<ArtifactTypeDefinition>
}

// === Artifact store (held by House) ===

export interface ArtifactFilter {
  readonly type?: string
  readonly scope?: string    // room ID — returns artifacts scoped to this room + system-wide
  readonly includeResolved?: boolean  // default false
}

export interface ArtifactStore {
  readonly add: (config: ArtifactCreateConfig) => Artifact
  readonly update: (id: string, updates: ArtifactUpdateConfig, ctx?: ToolContext) => Artifact | undefined
  readonly remove: (id: string) => boolean
  readonly get: (id: string) => Artifact | undefined
  readonly list: (filter?: ArtifactFilter) => ReadonlyArray<Artifact>
  readonly getForScope: (roomId: string) => ReadonlyArray<Artifact>
  readonly restore: (artifacts: ReadonlyArray<Artifact>) => void
}

export type OnArtifactChanged = (action: 'added' | 'updated' | 'removed' | 'resolved', artifact: Artifact) => void
