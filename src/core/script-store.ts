// ============================================================================
// Script store — filesystem-backed loader (v2 shape).
//
// Layout (mirrors src/skills/loader.ts):
//   $SAMSINN_HOME/scripts/<name>/script.json      ← preferred
//   $SAMSINN_HOME/scripts/<name>.json             ← flat-form (single file)
//
// Each entry is parsed into a Script and registered under <name>. The name
// must match VALID_NAME (lowercase alphanumerics + dash + underscore).
//
// v2 shape: cast (≥2, exactly 2 in v1) + steps (≥1) + optional contextOverrides.
// ============================================================================

import { readdir, readFile, stat, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  Script,
  Step,
  CastMember,
  ContextOverrides,
} from './types/script.ts'

const VALID_NAME = /^[a-z0-9][a-z0-9_-]*$/

export interface ScriptStore {
  readonly get: (name: string) => Script | undefined
  readonly list: () => ReadonlyArray<Script>
  readonly reload: () => Promise<ReadonlyArray<string>>   // returns names loaded
  readonly upsert: (raw: unknown) => Promise<Script>      // write file + reload + return parsed
  readonly remove: (name: string) => Promise<boolean>     // returns false if not found
}

export const createScriptStore = (baseDir: string): ScriptStore => {
  const scripts = new Map<string, Script>()

  const reload = async (): Promise<ReadonlyArray<string>> => {
    scripts.clear()
    const loaded = await scanScriptDir(baseDir)
    for (const s of loaded) scripts.set(s.name, s)
    return loaded.map(s => s.name)
  }

  const upsert = async (raw: unknown): Promise<Script> => {
    if (!raw || typeof raw !== 'object') throw new Error('script must be a JSON object')
    const obj = raw as Record<string, unknown>
    if (typeof obj.name !== 'string' || !VALID_NAME.test(obj.name)) {
      throw new Error(`script name must match ${VALID_NAME} (got "${String(obj.name)}")`)
    }
    const name = obj.name
    // Validate by parsing first so we never write garbage.
    const json = JSON.stringify(obj, null, 2)
    parseScript(name, json)
    // Write to dir-form (consistent with skills layout).
    const dir = join(baseDir, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'script.json'), json, 'utf-8')
    await reload()
    const reloaded = scripts.get(name)
    if (!reloaded) throw new Error(`upsert: script "${name}" did not reload`)
    return reloaded
  }

  const remove = async (name: string): Promise<boolean> => {
    if (!VALID_NAME.test(name)) return false
    const dir = join(baseDir, name)
    const flat = join(baseDir, `${name}.json`)
    let removed = false
    try { await rm(dir, { recursive: true, force: true }); removed = true } catch { /* may not exist */ }
    try { await rm(flat, { force: true }); removed = removed || true } catch { /* may not exist */ }
    if (removed) await reload()
    return scripts.get(name) === undefined && removed
  }

  return {
    get: (name) => scripts.get(name),
    list: () => [...scripts.values()],
    reload,
    upsert,
    remove,
  }
}

// === Filesystem scan ===

const scanScriptDir = async (baseDir: string): Promise<ReadonlyArray<Script>> => {
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch {
    return []
  }

  const out: Script[] = []
  for (const entry of entries) {
    const full = join(baseDir, entry)
    let info
    try { info = await stat(full) } catch { continue }

    let name: string
    let raw: string
    if (info.isDirectory()) {
      if (!VALID_NAME.test(entry)) {
        console.warn(`[scripts] "${entry}": directory name not a valid script name — skipping`)
        continue
      }
      try {
        raw = await readFile(join(full, 'script.json'), 'utf-8')
      } catch {
        continue
      }
      name = entry
    } else if (info.isFile() && entry.endsWith('.json')) {
      const stem = entry.slice(0, -'.json'.length)
      if (!VALID_NAME.test(stem)) {
        console.warn(`[scripts] "${entry}": filename not a valid script name — skipping`)
        continue
      }
      try {
        raw = await readFile(full, 'utf-8')
      } catch (err) {
        console.warn(`[scripts] "${entry}": read failed — ${err instanceof Error ? err.message : err}`)
        continue
      }
      name = stem
    } else {
      continue
    }

    try {
      const parsed = parseScript(name, raw)
      out.push(parsed)
    } catch (err) {
      console.warn(`[scripts] "${name}": invalid — ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`[scripts] ${baseDir}: ${out.length} loaded`)
  return out
}

// === Parsing + validation ===

export const parseScript = (name: string, raw: string): Script => {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : err}`)
  }
  if (!json || typeof json !== 'object') throw new Error('script must be a JSON object')
  const j = json as Record<string, unknown>

  if (typeof j.title !== 'string' || j.title.trim() === '') {
    throw new Error('title: required non-empty string')
  }
  const prompt = typeof j.prompt === 'string' ? j.prompt : undefined

  const cast = parseCast(j.cast)
  if (cast.length !== 2) throw new Error(`cast: v1 requires exactly 2 members (got ${cast.length})`)
  const startsCount = cast.filter(c => c.starts).length
  if (startsCount !== 1) {
    throw new Error(`cast: exactly one member must have starts: true (got ${startsCount})`)
  }

  const castNames = new Set(cast.map(c => c.name))
  const steps = parseSteps(j.steps, castNames)
  const contextOverrides = parseContextOverrides(j.contextOverrides)

  return {
    id: crypto.randomUUID(),
    name,
    title: j.title,
    ...(prompt !== undefined ? { prompt } : {}),
    cast,
    steps,
    ...(contextOverrides !== undefined ? { contextOverrides } : {}),
  }
}

const parseCast = (raw: unknown): ReadonlyArray<CastMember> => {
  if (!Array.isArray(raw)) throw new Error('cast: must be an array')
  const out: CastMember[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]
    if (!v || typeof v !== 'object') throw new Error(`cast[${i}]: must be an object`)
    const c = v as Record<string, unknown>
    if (typeof c.name !== 'string' || c.name.trim() === '') {
      throw new Error(`cast[${i}].name: required non-empty string`)
    }
    if (seen.has(c.name)) throw new Error(`cast: duplicate name "${c.name}"`)
    seen.add(c.name)
    if (typeof c.persona !== 'string' || c.persona.trim() === '') {
      throw new Error(`cast[${i}].persona: required non-empty string`)
    }
    if (typeof c.model !== 'string' || c.model.trim() === '') {
      throw new Error(`cast[${i}].model: required non-empty string`)
    }
    let tools: ReadonlyArray<string> | undefined
    if (c.tools !== undefined) {
      if (!Array.isArray(c.tools) || c.tools.some(t => typeof t !== 'string')) {
        throw new Error(`cast[${i}].tools: must be a string array`)
      }
      tools = c.tools as string[]
    }
    out.push({
      name: c.name,
      persona: c.persona,
      model: c.model,
      ...(c.starts === true ? { starts: true } : {}),
      ...(tools ? { tools } : {}),
    })
  }
  return out
}

const parseSteps = (raw: unknown, castNames: ReadonlySet<string>): ReadonlyArray<Step> => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('steps: must be a non-empty array')
  }
  return raw.map((s, i) => parseStep(s, i, castNames))
}

const parseStep = (
  raw: unknown,
  index: number,
  castNames: ReadonlySet<string>,
): Step => {
  if (!raw || typeof raw !== 'object') throw new Error(`steps[${index}]: must be an object`)
  const s = raw as Record<string, unknown>
  if (typeof s.title !== 'string' || s.title.trim() === '') {
    throw new Error(`steps[${index}].title: required non-empty string`)
  }
  if (!s.roles || typeof s.roles !== 'object') {
    throw new Error(`steps[${index}].roles: required object keyed by cast name`)
  }
  const roles: Record<string, string> = {}
  for (const [castName, role] of Object.entries(s.roles as Record<string, unknown>)) {
    if (!castNames.has(castName)) {
      throw new Error(`steps[${index}].roles: "${castName}" not in cast`)
    }
    if (typeof role !== 'string' || role.trim() === '') {
      throw new Error(`steps[${index}].roles.${castName}: required non-empty string`)
    }
    roles[castName] = role
  }
  // Every cast member must have a role declared for every step.
  for (const c of castNames) {
    if (!roles[c]) {
      throw new Error(`steps[${index}].roles.${c}: missing role for cast member`)
    }
  }
  return {
    title: s.title,
    ...(typeof s.description === 'string' ? { description: s.description } : {}),
    roles,
  }
}

const parseContextOverrides = (raw: unknown): ContextOverrides | undefined => {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object') {
    throw new Error('contextOverrides: must be an object')
  }
  const o = raw as Record<string, unknown>
  const result: ContextOverrides = {}

  if (o.includePrompts !== undefined) {
    if (!o.includePrompts || typeof o.includePrompts !== 'object') {
      throw new Error('contextOverrides.includePrompts: must be an object')
    }
    const ip = o.includePrompts as Record<string, unknown>
    const allowed = ['persona', 'room', 'house', 'responseFormat', 'skills', 'script']
    for (const k of Object.keys(ip)) {
      if (!allowed.includes(k)) throw new Error(`contextOverrides.includePrompts.${k}: unknown key`)
      if (typeof ip[k] !== 'boolean') throw new Error(`contextOverrides.includePrompts.${k}: must be boolean`)
    }
    ;(result as { includePrompts?: ContextOverrides['includePrompts'] }).includePrompts = ip as ContextOverrides['includePrompts']
  }

  if (o.includeContext !== undefined) {
    if (!o.includeContext || typeof o.includeContext !== 'object') {
      throw new Error('contextOverrides.includeContext: must be an object')
    }
    const ic = o.includeContext as Record<string, unknown>
    const allowed = ['participants', 'artifacts', 'activity', 'knownAgents']
    for (const k of Object.keys(ic)) {
      if (!allowed.includes(k)) throw new Error(`contextOverrides.includeContext.${k}: unknown key`)
      if (typeof ic[k] !== 'boolean') throw new Error(`contextOverrides.includeContext.${k}: must be boolean`)
    }
    ;(result as { includeContext?: ContextOverrides['includeContext'] }).includeContext = ic as ContextOverrides['includeContext']
  }

  if (o.includeTools !== undefined) {
    if (typeof o.includeTools !== 'boolean') {
      throw new Error('contextOverrides.includeTools: must be boolean')
    }
    ;(result as { includeTools?: boolean }).includeTools = o.includeTools
  }

  return result
}
