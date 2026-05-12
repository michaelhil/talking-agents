// ============================================================================
// Scenario types — declarative, replayable scripted configuration.
//
// Scenarios live at <pack>/scenarios/<name>/scenario.md (or flat .md). The
// markdown body holds free narration (rendered in the consent dialog) plus
// one or more ```scenario YAML blocks listing typed ops.
//
// Lifecycle is persistent-only in v1: setup ops are idempotent against
// current room/agent state. Re-runs reuse existing entities by name.
// ============================================================================

// Scenario category. Drives UI grouping in the scenarios list, and the
// load-time `assertDemoIsHandsFree` check: scenarios tagged `demo` must
// run end-to-end with no `waitFor: { type: 'click' }` guide ops. `tutorial`
// scenarios may use blocking clicks (they're intentionally interactive).
// `onboarding` is reserved for the first-boot welcome flow. Default is
// `tutorial` — conservative: anything not explicitly marked a hands-free
// demo escapes the assertion.
export type ScenarioCategory = 'demo' | 'tutorial' | 'onboarding'

export interface ScenarioFrontmatter {
  readonly title: string
  readonly description?: string
  readonly category?: ScenarioCategory
}

// === Op union ===
//
// Every op is { kind, line, ...params }. Names mirror the markdown DSL keys
// (`install-pack`, `create-room`, etc.) — the parser maps directly. `line`
// is the 1-based source line of the op's `- <kind>:` introducer; surfaced
// in parse-time and runtime error messages so authors can navigate to the
// offending line.
interface OpBase {
  readonly line: number
  // Optional author label. Used by `branch-on-llm-decision` (and any future
  // jump op) to reference jump targets by name instead of by index. Stable
  // across op-list reordering. Authors only label ops they want to jump to.
  readonly id?: string
}

export type ScenarioOp =
  | (OpBase & { readonly kind: 'install-pack'; readonly source: string; readonly name?: string })
  | (OpBase & { readonly kind: 'create-room'; readonly name: string; readonly roomPrompt?: string })
  | (OpBase & { readonly kind: 'activate-pack'; readonly room: string; readonly pack: string })
  | (OpBase & {
      readonly kind: 'spawn-agent'
      readonly room: string
      readonly name: string
      readonly model: string
      readonly persona: string
      readonly tools?: ReadonlyArray<string>
    })
  | (OpBase & {
      readonly kind: 'spawn-human'
      readonly room: string
      readonly name: string
    })
  | (OpBase & {
      readonly kind: 'post-message'
      readonly room: string
      readonly as: string                    // agent name OR 'system'
      readonly body: string
    })
  | (OpBase & { readonly kind: 'start-script'; readonly room: string; readonly scriptName: string })
  // Inline-script: parses + starts a script literal embedded in the scenario
  // body (no separate script file). Useful for one-off compositions inside a
  // scenario. Source must be a valid script markdown body matching the
  // grammar in docs/scripts.md (starting with `# SCRIPT: <title>`).
  // Bypasses pack-activation gating (the scenario itself is the source of
  // truth). Cleanup on scenario abort/stop is registered automatically.
  | (OpBase & { readonly kind: 'inline-script'; readonly room: string; readonly source: string })
  // branch-on-llm-decision: asks an LLM to pick among declared branches
  // (referenced by op `id`). The op-handler whitelist remains the security
  // boundary — the LLM chooses *order*, not *behavior*. Prompt-injection
  // limitation: when context (`fromRoom`) includes user-controlled chat,
  // crafted messages can steer the choice. Suitable for friendly flows;
  // not adversarially robust.
  | (OpBase & {
      readonly kind: 'branch-on-llm-decision'
      readonly prompt: string                 // system message to the LLM
      readonly fromRoom?: string              // optional: include last 5 messages from this room as user context
      readonly branches: Record<string, string> // map: choice-token → target op `id`
      readonly fallback: string               // op `id` to use when LLM reply doesn't match any branch
      readonly model?: string                 // optional: model id; defaults to first-AI-agent's model
    })
  | (OpBase & {
      readonly kind: 'guide-tooltip'
      readonly selector: string              // CSS selector against existing data-*
      readonly body: string
      readonly waitFor?: GuideWait
    })
  | (OpBase & {
      readonly kind: 'guide-modal'
      readonly title: string
      readonly body: string
      readonly waitFor?: GuideWait
    })
  // Lightweight non-blocking notification — corner toast that auto-dismisses.
  // No waitFor — toasts are by design transient. Use guide-tooltip with
  // waitFor: click for "user must acknowledge" beats.
  | (OpBase & {
      readonly kind: 'guide-toast'
      readonly body: string
      readonly variant?: 'success' | 'error'
    })
  // Standalone wait — pause the runner pending an external event subscription.
  // For waits attached to a guide, use guide-tooltip/guide-modal's waitFor.
  | (OpBase & {
      readonly kind: 'wait'
      readonly waitFor: ExternalWait
    })

export type GuideWait =
  | { readonly type: 'click'; readonly selector?: string }   // selector defaults to anchor
  | { readonly type: 'post'; readonly room: string }
  | { readonly type: 'timer'; readonly seconds: number }

// External-source waits accepted by the standalone `wait` op. Mirrors
// ExternalWaitArgs in waits.ts but lives here so types.ts stays the single
// source of truth for the public op shape.
export type ExternalWait =
  | { readonly type: 'timer'; readonly seconds: number }
  | { readonly type: 'llm-response'; readonly agent: string }
  | { readonly type: 'script-completed'; readonly room: string; readonly scriptName: string }

// === Parsed scenario (in-memory) ===

export interface Scenario {
  readonly id: string                  // `<pack>/<name>`
  readonly pack: string
  readonly name: string
  readonly title: string
  readonly description?: string
  readonly category?: ScenarioCategory
  readonly source: string              // raw markdown
  readonly narration: string           // body with ```scenario blocks stripped
  readonly ops: ReadonlyArray<ScenarioOp>
}

// === Run state ===

export type RunStatus = 'running' | 'awaiting' | 'completed' | 'failed' | 'stopped'

export interface ScenarioRun {
  readonly runId: string
  readonly scenarioId: string
  readonly title: string
  status: RunStatus
  currentOpIndex: number
  totalOps: number
  startedAt: number
  lastTouchedAt: number
  // Set when status === 'awaiting'; cleared on resume.
  awaitingWait?: GuideWait
  // Set on 'failed'.
  failureReason?: string
  // Set on 'failed' / 'stopped' / 'completed'.
  endedAt?: number
}

// === Run options (per-call) ===

export interface RunOptions {
  // Author has explicitly granted pack-install consent for this run via the
  // share-link consent dialog. install-pack ops fail otherwise.
  readonly allowInstall?: boolean
  // The room name the user has open at run-start. Scenarios that target
  // `__CURRENT_ROOM__` in any `room:` field resolve to this. When the user
  // has no room open (e.g. share-link with no prior session), this is
  // undefined and ops fall back to the first available room (or fail with
  // a clear error if none exist).
  readonly currentRoom?: string
  // User-selected model from the run dialog. When set, replaces
  // `__DEFAULT_MODEL__` in any spawn-agent op for this run. Unset =
  // resolve at run-time via the system's current curated default
  // (resolveDefaultModel). The dialog pre-populates this from
  // /api/models's defaultModel so the user can simply confirm.
  readonly model?: string
}

// Placeholder string that scenario authors use in `room:` fields to mean
// "the room the user has open at run-start." Resolved by ops.ts via
// `resolveRoomName` before any room lookup. Centralized so the resolver
// and the demo scenarios agree on the spelling.
export const CURRENT_ROOM_PLACEHOLDER = '__CURRENT_ROOM__'

// Placeholder string scenario authors use in `model:` fields to mean
// "whatever the user's currently-preferred default model is." Resolved
// at run-time, not at scenario-load — so changing the curated default,
// adding a provider key, or the user picking a model in the run dialog
// all take effect immediately without re-loading the scenario store.
//
// Why a runtime placeholder rather than load-time substitution:
//   - Load-time substitution freezes a value at boot. A bad resolution
//     at that moment (provider transiently down, env not loaded yet,
//     stale catalog before bun --watch reloaded) persists for the
//     lifetime of the server.
//   - Authors never have to know the canonical model id at write time —
//     the platform default flows in.
export const DEFAULT_MODEL_PLACEHOLDER = '__DEFAULT_MODEL__'
