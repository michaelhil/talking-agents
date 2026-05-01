// ============================================================================
// Living-script renderer.
//
// Pure function: ScriptRun + viewer (cast name | null) → markdown text.
//
// The output is the document the cast members read AS their system prompt
// (when viewer = a cast name) and the document the right-rail UI panel
// shows you (when viewer = null, the "director" view that includes ALL
// whispers).
//
// AST-driven: builds the doc from parsed Script + per-step dialogue logs.
// Never string-substitutes the original source.
// ============================================================================

import type { Script, ScriptRun, DialogueEntry, CastMember } from '../types/script.ts'

const personaOneLine = (persona: string): string => {
  const trimmed = persona.trim()
  // First sentence-ish or first 140 chars.
  const m = /^(.{20,200}?[.!?])(\s|$)/.exec(trimmed)
  if (m) return m[1]!.trim()
  if (trimmed.length <= 140) return trimmed
  return trimmed.slice(0, 137).trim() + '…'
}

const renderHeader = (script: Script, viewer: string | null): string => {
  const lines: string[] = []
  lines.push(`# SCRIPT: ${script.title}`)
  if (script.premise) lines.push(`Premise: ${script.premise}`)
  lines.push('')
  lines.push('## Cast')
  for (const c of script.cast) {
    const startsTag = c.starts ? '  (starts)' : ''
    const youTag = viewer && c.name === viewer ? '  (you)' : ''
    lines.push('')
    lines.push(`### ${c.name}${startsTag}${youTag}`)
    lines.push(`- persona: ${personaOneLine(c.persona)}`)
  }
  return lines.join('\n')
}

const renderRoles = (
  cast: ReadonlyArray<CastMember>,
  step: { roles: Readonly<Record<string, string>> },
  overrides: Record<string, string>,
): string => {
  const lines = ['Roles:']
  for (const c of cast) {
    const role = overrides[c.name] ?? step.roles[c.name] ?? ''
    lines.push(`  ${c.name} — ${role || '—'}`)
  }
  return lines.join('\n')
}

const renderDialogue = (
  entry: DialogueEntry,
  viewerCastName: string | null,
  showAllWhispers: boolean,
): string[] => {
  const out = [`  ${entry.speaker}: ${entry.content}`]
  // Director view: show all whispers attributed to this turn.
  // Cast view: show only the viewer's own whispers.
  for (const [castName, record] of Object.entries(entry.whispersByCast)) {
    if (!showAllWhispers && castName !== viewerCastName) continue
    const w = record.whisper
    const parts: string[] = []
    if (w.notes) parts.push(`"${w.notes}"`)
    if (w.addressing) parts.push(`→ ${w.addressing}`)
    if (parts.length === 0) continue
    const label = showAllWhispers ? `whisper (${castName})` : 'whisper'
    out.push(`    ↳ ${label}: ${parts.join(' ')}`)
  }
  return out
}

const renderPressureBlock = (
  cast: ReadonlyArray<CastMember>,
  readiness: Record<string, boolean>,
  readyStreak: Record<string, number>,
  whisperFailures: number,
): string => {
  const lines = ['Pressure to proceed:']
  for (const c of cast) {
    const ready = readiness[c.name] === true
    const streak = readyStreak[c.name] ?? 0
    if (ready) {
      lines.push(`  ${c.name} — ready${streak > 1 ? ` (asked ${streak}×)` : ''}`)
    } else {
      lines.push(`  ${c.name} — not ready`)
    }
  }
  if (whisperFailures >= 3) {
    lines.push(`  ⚠ ${whisperFailures} consecutive whisper-classification failures`)
  }
  return lines.join('\n')
}

export interface RenderOptions {
  // When false, dialogue entries inside each step are omitted (Pressure
  // block + roles + goal are kept). Use for the LLM-context system prompt
  // — the dialogue is fed separately as user/assistant messages so the
  // model treats it as conversation, not as a doc to continue from.
  readonly includeDialogue?: boolean
}

export const renderLivingScript = (
  run: ScriptRun,
  viewerCastName: string | null,
  opts: RenderOptions = {},
): string => {
  const includeDialogue = opts.includeDialogue ?? true
  const { script } = run
  const showAllWhispers = viewerCastName === null
  const sections: string[] = [renderHeader(script, viewerCastName)]
  sections.push('---')

  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i]!
    const log = run.stepLogs[i]
    const isComplete = i < run.currentStep
    const isCurrent = i === run.currentStep && !run.ended
    const status = isComplete ? '  [COMPLETE]' : isCurrent ? '  [CURRENT]' : ''

    const stepLines: string[] = []
    stepLines.push(`## Step ${i + 1} — ${step.title}${status}`)
    if (step.goal) stepLines.push(`Goal: ${step.goal}`)
    stepLines.push(renderRoles(script.cast, step, isCurrent ? run.roleOverrides : {}))

    if (isCurrent) {
      stepLines.push('')
      stepLines.push(renderPressureBlock(
        script.cast, run.readiness, run.readyStreak, run.whisperFailures,
      ))
    }

    const entries = log?.entries ?? []
    if (includeDialogue && entries.length > 0) {
      stepLines.push('')
      const lastIdx = entries.length - 1
      for (let j = 0; j < entries.length; j++) {
        const dialogue = renderDialogue(entries[j]!, viewerCastName, showAllWhispers)
        if (isCurrent && j === lastIdx) {
          dialogue[0] = dialogue[0]! + '    ← last'
        }
        stepLines.push(...dialogue)
      }
    } else if (!includeDialogue && entries.length > 0) {
      // Brief summary when dialogue is suppressed (LLM context mode).
      stepLines.push('')
      stepLines.push(`  (${entries.length} message${entries.length === 1 ? '' : 's'} in this step — see conversation messages)`)
    }

    if (isComplete) {
      stepLines.push('  → advanced')
    }
    if (isCurrent && viewerCastName !== null) {
      const last = entries[entries.length - 1]
      if (!last || last.speaker !== viewerCastName) {
        stepLines.push('  (your turn)')
      }
    }

    sections.push(stepLines.join('\n'))
  }

  if (run.ended) {
    sections.push('---')
    sections.push('## Script complete')
  }

  return sections.join('\n\n')
}
