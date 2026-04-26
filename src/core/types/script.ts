// ============================================================================
// Script types — multi-agent collaborative scripts (v2 — see docs/scripts.md).
//
// A script is a passive document. Definition lives on the filesystem under
// $SAMSINN_HOME/scripts/<name>/script.json (or flat <name>.json). At start
// time the runner spawns the cast as normal AI agents, sets the room to
// manual, and reacts to each cast post by classifying a "whisper" (small
// JSON-mode self-reflection) that drives step advancement.
//
// No engine loop. No phase-1 fan-out. The runner is a reactive listener
// over the room's existing onMessagePosted callback. See script-runner.ts.
// ============================================================================

// === Authored shape (what lives in script.json) ===

export interface CastMember {
  readonly name: string                                 // unique within script; used as agent name
  readonly persona: string
  readonly model: string
  readonly starts?: boolean                             // exactly one cast member is true
  readonly tools?: ReadonlyArray<string>                // optional regular tool list
}

export interface Step {
  readonly title: string
  readonly description?: string
  readonly roles: Readonly<Record<string, string>>      // castName → free-text role
}

export interface ContextOverrides {
  readonly includePrompts?: {
    readonly persona?: boolean
    readonly room?: boolean
    readonly house?: boolean
    readonly responseFormat?: boolean
    readonly skills?: boolean
    readonly script?: boolean                           // gates the SCRIPT block (Phase E)
  }
  readonly includeContext?: {
    readonly participants?: boolean
    readonly artifacts?: boolean
    readonly activity?: boolean
    readonly knownAgents?: boolean
  }
  readonly includeTools?: boolean
}

export interface Script {
  readonly id: string                                   // crypto.randomUUID() at load
  readonly name: string                                 // filesystem name
  readonly title: string
  readonly prompt?: string                              // hint shown next to the start button
  readonly cast: ReadonlyArray<CastMember>              // exactly 2 in v1
  readonly steps: ReadonlyArray<Step>                   // ≥1
  readonly contextOverrides?: ContextOverrides
}

// === Runtime shapes (built in Phase B/C/D) ===

export interface Whisper {
  readonly ready_to_advance: boolean
  readonly notes?: string                               // ≤200 chars
  readonly addressing?: string                          // a present cast name
  readonly role_update?: string                         // self-update for current step's role
}

export interface ScriptRun {
  readonly script: Script
  readonly roomId: string
  currentStep: number
  turn: number                                          // total turns within current step
  readiness: Record<string, boolean>                    // castName → ready_to_advance
  roleOverrides: Record<string, string>                 // castName → current role override
  lastWhisper: Record<string, Whisper>                  // castName → most recent whisper
  whisperFailures: number                               // consecutive failures, surfaced in UI
  priorMode?: 'broadcast' | 'manual'                    // restored on stop
  ended: boolean
}
