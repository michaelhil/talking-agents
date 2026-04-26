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
  readonly rawResponse?: string                         // last raw model output (captured on failure)
  readonly errorReason?: string                         // why we fell back
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

// Soft-cap caps for free-text fields. Models routinely overshoot these
// when feeling expressive; truncating is preferable to rejecting the
// whole whisper (rejection forces a fallback that flips ready→false and
// can stall the script in a "no one is ever ready" loop).
const NOTES_MAX = 200
const ROLE_UPDATE_MAX = 200

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 1).trim() + '…'

const validate = (parsed: unknown, presentCast: ReadonlyArray<string>): { whisper: Whisper } | { error: string } => {
  if (!parsed || typeof parsed !== 'object') return { error: 'not an object' }
  const p = parsed as Record<string, unknown>
  if (typeof p.ready_to_advance !== 'boolean') return { error: 'ready_to_advance must be a boolean' }
  const w: { -readonly [K in keyof Whisper]: Whisper[K] } = { ready_to_advance: p.ready_to_advance }
  if (p.notes !== undefined && p.notes !== null) {
    if (typeof p.notes !== 'string') return { error: 'notes must be a string' }
    if (p.notes.length > 0) w.notes = truncate(p.notes, NOTES_MAX)
  }
  if (p.addressing !== undefined && p.addressing !== null && p.addressing !== '') {
    if (typeof p.addressing !== 'string') return { error: 'addressing must be a string' }
    if (!presentCast.includes(p.addressing)) return { error: `addressing "${p.addressing}" not in present cast` }
    w.addressing = p.addressing
  }
  if (p.role_update !== undefined && p.role_update !== null && p.role_update !== '') {
    if (typeof p.role_update !== 'string') return { error: 'role_update must be a string' }
    w.role_update = truncate(p.role_update, ROLE_UPDATE_MAX)
  }
  return { whisper: w }
}

export const classifyWhisper = async (args: ClassifyArgs): Promise<ClassifyResult> => {
  let lastRaw: string | undefined
  const attempt = async (retryNote?: string): Promise<{ whisper: Whisper } | { error: string }> => {
    let raw: string
    try {
      const response = await args.llm.chat({
        model: args.model,
        messages: [{ role: 'user', content: buildPrompt(args, retryNote) }],
        temperature: 0,
        // Generous cap for whisper output. Thinking-mode models (Gemini 2.5
        // Pro, Claude 4 with thinking) burn budget before producing output;
        // a small cap can leave the response empty. The actual JSON we expect
        // is ~80 tokens — the slack covers reasoning.
        maxTokens: 2000,
        jsonMode: true,
      })
      raw = response.content.trim()
      lastRaw = raw
    } catch (err) {
      return { error: `chat failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    const cleaned = stripMarkdownFences(raw)
    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      const extracted = extractJsonObject(cleaned)
      if (extracted === null) {
        return { error: `parse failed: response was not valid JSON: ${raw.slice(0, 200)}` }
      }
      try {
        parsed = JSON.parse(extracted)
      } catch {
        return { error: `parse failed: extracted block was not valid JSON: ${extracted.slice(0, 200)}` }
      }
    }
    return validate(parsed, args.presentCast)
  }

  const first = await attempt()
  if ('whisper' in first) return { whisper: first.whisper, usedFallback: false }

  const second = await attempt(`Your previous reply was rejected: ${first.error}. Reply ONLY with the JSON object.`)
  if ('whisper' in second) return { whisper: second.whisper, usedFallback: false }

  console.warn(`[script-whisper] both attempts failed: ${second.error} — falling back. raw response: ${(lastRaw ?? '').slice(0, 300)}`)
  return {
    whisper: { ready_to_advance: false },
    usedFallback: true,
    rawResponse: lastRaw,
    errorReason: second.error,
  }
}

// Strip markdown code fences if the model wrapped the JSON in ```json ... ```
const stripMarkdownFences = (s: string): string => {
  const trimmed = s.trim()
  // Common shape: ```json\n...\n``` or ```\n...\n```
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed)
  if (fence && fence[1]) return fence[1].trim()
  return trimmed
}

// Extract the first balanced top-level JSON object from a longer string.
const extractJsonObject = (s: string): string | null => {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!
    if (inStr) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

// Export internals for testing (not part of the runtime contract).
export const __test = { buildPrompt, validate, stripMarkdownFences, extractJsonObject }
