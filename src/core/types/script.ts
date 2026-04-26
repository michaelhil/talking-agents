// ============================================================================
// Script types — multi-agent collaborative scripts (v3 — markdown-native).
//
// Scripts are stored as markdown files (script.md) and parsed into the
// shapes below. The same shape that's loaded from disk drives the runtime
// state and the living-document view rendered into each cast member's
// system prompt + the right-rail UI panel.
//
// See docs/scripts.md for the format.
// ============================================================================

import type { IncludePrompts, IncludeContext } from './agent.ts'

// === Authored shape (parsed from script.md) ===

export interface CastMember {
  readonly name: string                                 // unique within script; used as agent name
  readonly persona: string                              // multiline; rendered as one block in the doc
  readonly model: string
  readonly starts?: boolean                             // exactly one cast member is true
  readonly tools?: ReadonlyArray<string>                // optional tool list (always includes nothing extra by default)
  readonly includePrompts?: IncludePrompts              // forwarded to the spawned agent's config
  readonly includeContext?: IncludeContext
  readonly includeTools?: boolean
}

export interface Step {
  readonly index: number                                // 0-based; assigned by parser
  readonly title: string
  readonly goal?: string
  readonly roles: Readonly<Record<string, string>>      // castName → "role1; role2"
}

export interface Script {
  readonly id: string                                   // crypto.randomUUID() at load
  readonly name: string                                 // filesystem name
  readonly title: string
  readonly premise?: string
  readonly cast: ReadonlyArray<CastMember>              // exactly 2 in v1
  readonly steps: ReadonlyArray<Step>                   // ≥1
  readonly source: string                               // raw .md text — for round-trip / debug
}

// === Whisper (post-turn self-reflection, unchanged shape) ===

export interface Whisper {
  readonly ready_to_advance: boolean
  readonly notes?: string                               // ≤200 chars
  readonly addressing?: string                          // a present cast name
  readonly role_update?: string                         // self-update for current step's role
}

export interface WhisperRecord {
  readonly turn: number
  readonly whisper: Whisper
  readonly usedFallback: boolean
  readonly rawResponse?: string
  readonly errorReason?: string
}

// === Per-step dialogue accumulator ===

export interface DialogueEntry {
  readonly speaker: string                              // cast name OR non-cast sender name
  readonly content: string
  readonly messageId: string                            // for de-dup
  readonly whispersByCast: Readonly<Record<string, WhisperRecord>>
  // ↑ whispers attributed to THIS turn, keyed by cast name. Renderer picks
  //   out only the viewer's own whisper when rendering a cast view.
}

export interface StepLog {
  readonly entries: ReadonlyArray<DialogueEntry>
  readonly advancedAt?: number                          // turn count at advance; undefined = current/upcoming
}

// === Runtime state ===

export interface ScriptRun {
  readonly script: Script
  readonly roomId: string
  currentStep: number                                   // 0-based
  turn: number                                          // total turns within current step
  readiness: Record<string, boolean>                    // castName → ready_to_advance
  readyStreak: Record<string, number>                   // castName → consecutive ready turns this step
  roleOverrides: Record<string, string>                 // castName → current role override
  stepLogs: StepLog[]                                   // index aligned with script.steps
  whisperFailures: number                               // consecutive failures, surfaced in UI
  priorMode?: 'broadcast' | 'manual'                    // restored on stop
  ended: boolean
}
