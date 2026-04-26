// ============================================================================
// Script whisper — small JSON-mode classification call after every cast
// member's dialogue post.
//
// Pure function (besides the llm.chat call). Caller passes in the LLM, the
// just-posted message text, the per-agent script context block, and the
// list of present cast names. We retry once on parse/validation failure;
// on second failure we return a default whisper so the runner never stalls.
//
// See docs/scripts.md.
// ============================================================================

import type { LLMProvider } from './types/llm.ts'
import type { Whisper } from './types/script.ts'

export interface ClassifyArgs {
  readonly llm: LLMProvider
  readonly model: string
  readonly message: string                              // dialogue the agent just posted
  readonly scriptContext: string                        // current step + role + readiness
  readonly presentCast: ReadonlyArray<string>
}

export interface ClassifyResult {
  readonly whisper: Whisper
  readonly usedFallback: boolean
}

const buildPrompt = (args: ClassifyArgs, retryNote?: string): string => {
  const cast = args.presentCast.join(', ')
  return [
    `You just wrote (in your role as a script cast member):`,
    `"""`,
    args.message,
    `"""`,
    ``,
    args.scriptContext,
    ``,
    `Reflect on what you just said and reply with a JSON object describing your turn.`,
    `Schema:`,
    `{`,
    `  "ready_to_advance": boolean,    // true if you think this step's goal has been substantially served from your side`,
    `  "notes": "string (optional, ≤200 chars) — what you'd still want, or what you flagged",`,
    `  "addressing": "string (optional) — name of a peer (one of: ${cast}) you are directing your next remark to",`,
    `  "role_update": "string (optional) — a short phrase replacing your current role for the next turn"`,
    `}`,
    ``,
    `Reply with ONLY the JSON object. No prose, no markdown fences.`,
    retryNote ? `\nNOTE: ${retryNote}` : '',
  ].filter(Boolean).join('\n')
}

const validate = (parsed: unknown, presentCast: ReadonlyArray<string>): { whisper: Whisper } | { error: string } => {
  if (!parsed || typeof parsed !== 'object') return { error: 'not an object' }
  const p = parsed as Record<string, unknown>
  if (typeof p.ready_to_advance !== 'boolean') return { error: 'ready_to_advance must be a boolean' }
  const w: { -readonly [K in keyof Whisper]: Whisper[K] } = { ready_to_advance: p.ready_to_advance }
  if (p.notes !== undefined) {
    if (typeof p.notes !== 'string') return { error: 'notes must be a string' }
    if (p.notes.length > 200) return { error: 'notes must be ≤200 chars' }
    if (p.notes.length > 0) w.notes = p.notes
  }
  if (p.addressing !== undefined && p.addressing !== null && p.addressing !== '') {
    if (typeof p.addressing !== 'string') return { error: 'addressing must be a string' }
    if (!presentCast.includes(p.addressing)) return { error: `addressing "${p.addressing}" not in present cast` }
    w.addressing = p.addressing
  }
  if (p.role_update !== undefined && p.role_update !== null && p.role_update !== '') {
    if (typeof p.role_update !== 'string') return { error: 'role_update must be a string' }
    if (p.role_update.length > 200) return { error: 'role_update must be ≤200 chars' }
    w.role_update = p.role_update
  }
  return { whisper: w }
}

export const classifyWhisper = async (args: ClassifyArgs): Promise<ClassifyResult> => {
  const attempt = async (retryNote?: string): Promise<{ whisper: Whisper } | { error: string }> => {
    let raw: string
    try {
      const response = await args.llm.chat({
        model: args.model,
        messages: [{ role: 'user', content: buildPrompt(args, retryNote) }],
        temperature: 0,
        maxTokens: 300,
        jsonMode: true,
      })
      raw = response.content.trim()
    } catch (err) {
      return { error: `chat failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { error: `parse failed: response was not valid JSON: ${raw.slice(0, 120)}` }
    }
    return validate(parsed, args.presentCast)
  }

  const first = await attempt()
  if ('whisper' in first) return { whisper: first.whisper, usedFallback: false }

  const second = await attempt(`Your previous reply was rejected: ${first.error}. Reply ONLY with the JSON object.`)
  if ('whisper' in second) return { whisper: second.whisper, usedFallback: false }

  console.warn(`[script-whisper] both attempts failed: ${second.error} — falling back to ready_to_advance:false`)
  return { whisper: { ready_to_advance: false }, usedFallback: true }
}

// Export internals for testing (not part of the runtime contract).
export const __test = { buildPrompt, validate }
