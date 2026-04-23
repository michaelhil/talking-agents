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

import type { Tool, ToolRegistry } from '../core/types/tool.ts'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve, extname, basename } from 'node:path'
import { homedir } from 'node:os'

// Only letters, digits, underscores, hyphens — matches tool name conventions
export const VALID_NAME = /^[a-zA-Z0-9_-]+$/

export interface LoadResult {
  readonly loaded: ReadonlyArray<string>   // tool names successfully registered
  readonly skipped: ReadonlyArray<string>  // files skipped (conflict, invalid shape, bad name)
  readonly errors: ReadonlyArray<string>   // files that threw during import
}

export const isTool = (value: unknown): value is Tool => {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return (
    typeof t.name === 'string' && t.name.length > 0 &&
    typeof t.description === 'string' &&
    t.parameters !== null && typeof t.parameters === 'object' &&
    typeof t.execute === 'function'
  )
}

export interface LoadSource {
  readonly kind: 'external' | 'skill-bundled' | 'pack-bundled'
  readonly skill?: string          // owning skill name when kind is skill-bundled
  readonly pack?: string           // owning pack namespace when kind is pack-bundled
  readonly namespacePrefix?: string // registry key becomes `${prefix}_${toolName}` when set
}

// Load all .ts tool files from a single directory into the registry.
// Returns silently if the directory does not exist.
// Source metadata is attached to each registered tool so the detail endpoint
// and hot-reload path can locate the originating file.
//
// When `source.namespacePrefix` is set (pack-bundled), the registered key is
// `${prefix}_${candidate.name}` and the original name is preserved on
// `source.displayName`. The tool's own `name` field is left untouched — the
// registry key is the only thing that changes.
export const loadToolDirectory = async (
  dir: string,
  registry: ToolRegistry,
  source: LoadSource = { kind: 'external' },
): Promise<LoadResult> => {
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

  const tsFiles = entries.filter(f =>
    extname(f) === '.ts'
    && !basename(f, '.ts').startsWith('_')
    && !f.endsWith('.test.ts'),  // colocated tests share the dir; skip them
  )

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

      const displayName = candidate.name
      const registryKey = source.namespacePrefix
        ? `${source.namespacePrefix}_${displayName}`
        : displayName

      if (registry.has(registryKey)) {
        const desc = `${file}: tool "${registryKey}" already registered — skipping`
        skipped.push(desc)
        console.warn(`[tools] ${desc}`)
        continue
      }

      // When namespaced, rewrite the tool's name so the LLM-facing tool_call
      // identifier matches the registry key. Tool authors write the
      // unprefixed name; the loader applies the namespace at registration.
      const registered: Tool = source.namespacePrefix
        ? { ...candidate, name: registryKey }
        : (candidate as Tool)

      registry.registerWithSource(registered, {
        kind: source.kind,
        path: filePath,
        ...(source.skill ? { skill: source.skill } : {}),
        ...(source.pack ? { pack: source.pack } : {}),
        ...(source.namespacePrefix ? { displayName } : {}),
      })
      loaded.push(registryKey)
    }
  }))

  return { loaded, skipped, errors }
}

const externalDirs = (): string[] => {
  const dirs = [
    resolve(process.cwd(), 'tools'),
    join(homedir(), '.samsinn', 'tools'),
  ]
  const envDir = process.env.SAMSINN_TOOLS_DIR
  if (envDir) dirs.push(resolve(envDir))
  return dirs
}

// Load tools from all standard directories. Called once at startup before agents spawn.
export const loadExternalTools = async (registry: ToolRegistry): Promise<void> => {
  for (const dir of externalDirs()) {
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

export interface RescanResult {
  readonly added: ReadonlyArray<string>    // tool names newly registered
  readonly updated: ReadonlyArray<string>  // tool names re-imported (file modified)
  readonly removed: ReadonlyArray<string>  // tool names unregistered (file deleted)
  readonly errors: ReadonlyArray<string>
}

// Re-import external tool files on demand. Skill-bundled tools are left alone
// (they reload through write_tool or a full restart). The cachebust query
// string forces Bun to re-evaluate the module; each rescan gets a unique tag.
//
// Known limitation: a tool call in-flight during rescan holds a reference to
// the previous closure and will continue with old behavior until it returns.
export const rescanExternalTools = async (registry: ToolRegistry): Promise<RescanResult> => {
  const added: string[] = []
  const updated: string[] = []
  const removed: string[] = []
  const errors: string[] = []

  // Snapshot: path → names registered from that path (external only)
  const oldByPath = new Map<string, Set<string>>()
  for (const entry of registry.listEntries()) {
    if (entry.source.kind !== 'external' || !entry.source.path) continue
    const set = oldByPath.get(entry.source.path) ?? new Set<string>()
    set.add(entry.tool.name)
    oldByPath.set(entry.source.path, set)
  }

  const currentPaths = new Set<string>()

  for (const dir of externalDirs()) {
    try {
      const s = await stat(dir)
      if (!s.isDirectory()) continue
    } catch { continue }

    const entries = await readdir(dir)
    const tsFiles = entries.filter(f =>
    extname(f) === '.ts'
    && !basename(f, '.ts').startsWith('_')
    && !f.endsWith('.test.ts'),  // colocated tests share the dir; skip them
  )

    for (const file of tsFiles) {
      const filePath = join(dir, file)
      currentPaths.add(filePath)
      const oldNames = oldByPath.get(filePath) ?? new Set<string>()

      let mod: { default?: unknown }
      try {
        // Cachebust — matches the pattern write_tool uses so Bun re-evaluates.
        mod = await import(`${filePath}?t=${Date.now()}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${file}: ${msg}`)
        continue
      }

      const candidates = Array.isArray(mod.default) ? mod.default : [mod.default]
      const newNames = new Set<string>()

      for (const candidate of candidates) {
        if (!isTool(candidate)) continue
        if (!VALID_NAME.test(candidate.name)) continue

        // If another file already owns this name, don't clobber. Skill-bundled
        // or built-in tools win.
        const existing = registry.getEntry(candidate.name)
        if (existing && existing.source.kind !== 'external') continue
        if (existing && existing.source.path && existing.source.path !== filePath) continue

        registry.registerWithSource(candidate as Tool, { kind: 'external', path: filePath })
        newNames.add(candidate.name)

        if (oldNames.has(candidate.name)) updated.push(candidate.name)
        else added.push(candidate.name)
      }

      // Names present in the old version of this file but absent now —
      // treat as removed (file was edited to drop a tool).
      for (const oldName of oldNames) {
        if (!newNames.has(oldName)) {
          if (registry.unregister(oldName)) removed.push(oldName)
        }
      }
    }
  }

  // Files that disappeared entirely — unregister every tool they owned.
  for (const [oldPath, names] of oldByPath) {
    if (currentPaths.has(oldPath)) continue
    for (const name of names) {
      if (registry.unregister(name)) removed.push(name)
    }
  }

  return { added, updated, removed, errors }
}
