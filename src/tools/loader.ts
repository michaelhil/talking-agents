// ============================================================================
// Tool Loader — Filesystem-based tool discovery.
//
// Scans directories for .ts files and dynamically imports them as Tool objects.
// Each file should export a Tool or Tool[] as its default export.
//
// Load order (first registered wins on name conflict):
//   1. Built-ins (registered before loader is called)
//   2. ./tools/          — project-local tools
//   3. ~/.samsinn/tools/ — user-global tools
//   4. $SAMSINN_TOOLS_DIR — optional env override
//
// Loaded tools are available to all agents spawned after loading.
// Hot-reload is not supported: restart to pick up file changes.
// ============================================================================

import type { Tool, ToolRegistry } from '../core/types.ts'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve, extname, basename } from 'node:path'
import { homedir } from 'node:os'

// Only letters, digits, underscores, hyphens — matches tool name conventions
const VALID_NAME = /^[a-zA-Z0-9_-]+$/

export interface LoadResult {
  readonly loaded: ReadonlyArray<string>   // tool names successfully registered
  readonly skipped: ReadonlyArray<string>  // files skipped (conflict, invalid shape, bad name)
  readonly errors: ReadonlyArray<string>   // files that threw during import
}

const isTool = (value: unknown): value is Tool => {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t.name === 'string' && t.name.length > 0 &&
    typeof t.description === 'string' &&
    t.parameters !== null && typeof t.parameters === 'object' &&
    typeof t.execute === 'function'
  )
}

// Load all .ts tool files from a single directory into the registry.
// Returns silently if the directory does not exist.
export const loadToolDirectory = async (dir: string, registry: ToolRegistry): Promise<LoadResult> => {
  const loaded: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  try {
    const s = await stat(dir)
    if (!s.isDirectory()) return { loaded, skipped, errors }
  } catch {
    return { loaded, skipped, errors }
  }

  const entries = await readdir(dir)

  for (const entry of entries) {
    if (extname(entry) === '.js') {
      console.warn(`[tools] ${dir}/${entry}: skipping .js file — only .ts files are supported`)
    }
  }

  const tsFiles = entries.filter(f => extname(f) === '.ts' && !basename(f, '.ts').startsWith('_'))

  // Import all files in parallel
  await Promise.all(tsFiles.map(async (file) => {
    const filePath = join(dir, file)
    let mod: { default?: unknown }

    try {
      mod = await import(filePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${file}: ${msg}`)
      console.error(`[tools] ${file}: import failed — ${msg}`)
      return
    }

    const candidates = Array.isArray(mod.default) ? mod.default : [mod.default]

    for (const candidate of candidates) {
      if (!isTool(candidate)) {
        const desc = `${file}: invalid tool shape (needs name, description, parameters, execute)`
        skipped.push(desc)
        console.warn(`[tools] ${desc}`)
        continue
      }

      if (!VALID_NAME.test(candidate.name)) {
        const desc = `${file}: tool name "${candidate.name}" is invalid — use a-z, 0-9, _, -`
        skipped.push(desc)
        console.warn(`[tools] ${desc}`)
        continue
      }

      if (registry.has(candidate.name)) {
        const desc = `${file}: tool "${candidate.name}" already registered — skipping`
        skipped.push(desc)
        console.warn(`[tools] ${desc}`)
        continue
      }

      registry.register(candidate as Tool)
      loaded.push(candidate.name)
    }
  }))

  return { loaded, skipped, errors }
}

// Load tools from all standard directories. Called once at startup before agents spawn.
export const loadExternalTools = async (registry: ToolRegistry): Promise<void> => {
  const dirs: string[] = [
    resolve(process.cwd(), 'tools'),
    join(homedir(), '.samsinn', 'tools'),
  ]

  const envDir = process.env.SAMSINN_TOOLS_DIR
  if (envDir) dirs.push(resolve(envDir))

  for (const dir of dirs) {
    const result = await loadToolDirectory(dir, registry)
    const total = result.loaded.length + result.skipped.length + result.errors.length
    if (total > 0) {
      const parts = [
        result.loaded.length > 0 ? `${result.loaded.length} loaded` : null,
        result.skipped.length > 0 ? `${result.skipped.length} skipped` : null,
        result.errors.length > 0 ? `${result.errors.length} errors` : null,
      ].filter(Boolean).join(', ')
      console.log(`[tools] ${dir}: ${parts}`)
    }
  }
}
