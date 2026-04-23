// ============================================================================
// Skill Loader — Filesystem-based skill discovery.
//
// Scans a base directory for skill subdirectories. Each skill is a folder
// containing a SKILL.md file (YAML frontmatter + markdown body) and an
// optional tools/ subdirectory with .ts tool files.
//
// Format mirrors Claude Skills:
//   ---
//   name: skill-name
//   description: When to use this skill
//   scope: [room-name]
//   ---
//   Markdown body with behavioral instructions...
//
// Bundled tools in tools/ are registered in the shared ToolRegistry
// via the existing loadToolDirectory() function.
// ============================================================================

import type { ToolRegistry } from '../core/types/tool.ts'
import { VALID_NAME, loadToolDirectory } from '../tools/loader.ts'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface Skill {
  readonly name: string                 // registry key — `<pack>/<raw>` for pack skills, else raw
  readonly description: string
  readonly body: string
  readonly scope: ReadonlyArray<string>
  readonly tools: ReadonlyArray<string>
  readonly dirPath: string
  readonly pack?: string                // owning pack namespace (pack-scoped skills only)
  readonly displayName?: string         // unprefixed frontmatter name (pack-scoped only)
}

export interface SkillStore {
  readonly get: (name: string) => Skill | undefined
  readonly list: () => ReadonlyArray<Skill>
  readonly forScope: (roomName: string) => ReadonlyArray<Skill>
  readonly register: (skill: Skill) => void
  readonly remove: (name: string) => boolean
  // Bulk removal keyed by pack namespace — used on pack uninstall.
  readonly removeByPack: (pack: string) => ReadonlyArray<string>
}

export const createSkillStore = (): SkillStore => {
  const skills = new Map<string, Skill>()

  return {
    get: (name) => skills.get(name),
    list: () => [...skills.values()],
    forScope: (roomName) => [...skills.values()].filter(
      s => s.scope.length === 0 || s.scope.includes(roomName),
    ),
    register: (skill) => {
      if (skills.has(skill.name)) {
        console.warn(`[skills] Skill "${skill.name}" already registered — overwriting`)
      }
      skills.set(skill.name, skill)
    },
    remove: (name) => skills.delete(name),
    removeByPack: (pack) => {
      const removed: string[] = []
      for (const [key, skill] of skills) {
        if (skill.pack === pack) {
          skills.delete(key)
          removed.push(key)
        }
      }
      return removed
    },
  }
}

// --- Frontmatter parsing ---
// Simple parser — no YAML library. Handles string and string[] values.

interface Frontmatter {
  name?: string
  description?: string
  scope?: string[]
}

const parseArrayValue = (value: string): string[] => {
  // Handle [item1, item2] syntax
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
  }
  return [trimmed]
}

export const parseFrontmatter = (content: string): { frontmatter: Frontmatter; body: string } => {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: content }

  const endIdx = lines.indexOf('---', 1)
  if (endIdx === -1) return { frontmatter: {}, body: content }

  const frontmatter: Frontmatter = {}
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i] ?? ''
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key === 'name') frontmatter.name = value
    else if (key === 'description') frontmatter.description = value
    else if (key === 'scope') frontmatter.scope = parseArrayValue(value)
  }

  const body = lines.slice(endIdx + 1).join('\n').trim()
  return { frontmatter, body }
}

// --- Skill loading ---

export interface SkillLoadResult {
  readonly loaded: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
}

// When `namespacePrefix` is set, each skill's registry key becomes
// `${prefix}/${frontmatter.name}` and any bundled tools under tools/ are
// registered as pack-bundled with the same prefix. The raw frontmatter name
// is still validated against `VALID_NAME` — the prefix is applied after.
export interface LoadSkillsOptions {
  readonly namespacePrefix?: string
  readonly pack?: string  // forwarded to bundled-tool source meta and Skill.pack
}

export const loadSkills = async (
  baseDir: string,
  store: SkillStore,
  toolRegistry: ToolRegistry,
  options: LoadSkillsOptions = {},
): Promise<SkillLoadResult> => {
  const loaded: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  try {
    const s = await stat(baseDir)
    if (!s.isDirectory()) return { loaded, skipped, errors }
  } catch {
    return { loaded, skipped, errors }
  }

  const entries = await readdir(baseDir)

  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue

    const dirPath = join(baseDir, entry)
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) continue
    } catch { continue }

    const skillPath = join(dirPath, 'SKILL.md')
    let content: string
    try {
      content = await readFile(skillPath, 'utf-8')
    } catch {
      // No SKILL.md — skip silently (might just be a regular directory)
      continue
    }

    const { frontmatter, body } = parseFrontmatter(content)

    if (!frontmatter.name?.trim() || !frontmatter.description?.trim()) {
      skipped.push(`${entry}: SKILL.md missing required frontmatter (name, description)`)
      continue
    }

    if (!VALID_NAME.test(frontmatter.name)) {
      skipped.push(`${entry}: invalid skill name "${frontmatter.name}"`)
      continue
    }

    const rawName = frontmatter.name
    const registryKey = options.namespacePrefix
      ? `${options.namespacePrefix}/${rawName}`
      : rawName

    // Load bundled tools from tools/ subdir. Pack-scoped skills get
    // pack-bundled tools with the pack's namespace prefix; unscoped skills
    // keep the existing skill-bundled pathway.
    const toolsDir = join(dirPath, 'tools')
    let bundledTools: ReadonlyArray<string> = []
    try {
      const toolResult = options.pack
        ? await loadToolDirectory(toolsDir, toolRegistry, {
            kind: 'pack-bundled',
            pack: options.pack,
            namespacePrefix: options.pack,
          })
        : await loadToolDirectory(toolsDir, toolRegistry, {
            kind: 'skill-bundled',
            skill: rawName,
          })
      bundledTools = toolResult.loaded
      if (toolResult.loaded.length > 0) {
        console.log(`[skills] ${registryKey}: loaded ${toolResult.loaded.length} bundled tools`)
      }
      if (toolResult.errors.length > 0) {
        for (const err of toolResult.errors) errors.push(`${registryKey}/tools: ${err}`)
      }
    } catch { /* no tools/ dir — that's fine */ }

    const skill: Skill = {
      name: registryKey,
      description: frontmatter.description,
      body,
      scope: frontmatter.scope ?? [],
      tools: bundledTools,
      dirPath,
      ...(options.pack ? { pack: options.pack, displayName: rawName } : {}),
    }

    store.register(skill)
    loaded.push(skill.name)
  }

  if (loaded.length > 0 || skipped.length > 0 || errors.length > 0) {
    const parts = [
      loaded.length > 0 ? `${loaded.length} loaded` : null,
      skipped.length > 0 ? `${skipped.length} skipped` : null,
      errors.length > 0 ? `${errors.length} errors` : null,
    ].filter(Boolean).join(', ')
    console.log(`[skills] ${baseDir}: ${parts}`)
  }

  return { loaded, skipped, errors }
}
