// ============================================================================
// Category registry — single source of truth for which categories exist.
//
// File: $SAMSINN_HOME/geodata/categories.json
// Shape: { "version": 1, "categories": [<CategoryMeta>] }
//
// Concurrency: single async-mutex on the registry file. Per-category
// .geojson files have their own mutex in store.ts; the registry mutex
// only serializes operations on categories.json itself.
//
// Validation rules (enforced on upsert):
//   - id matches /^[a-z][a-z0-9-]{0,62}$/
//   - displayName is a non-empty string
//   - icon is in MARKER_ICONS
//   - osmQuery (if present) is a non-empty string and contains `{name}` exactly once
//
// Delete-cascade: deleteCategory writes the new registry FIRST (without the
// entry), then unlinks the per-category .geojson. If the unlink fails the
// orphan file is harmless — the registry no longer references it.
// ============================================================================

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sharedPaths } from '../core/paths.ts'
import { isMarkerIcon, type CategoryMeta, type CategoryRegistryFile } from './types.ts'

const REGISTRY_VERSION: 1 = 1
const ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/

const registryPath = (): string => join(sharedPaths.geodata(), 'categories.json')
const categoryFilePath = (id: string): string => join(sharedPaths.geodata(), `${id}.geojson`)

// ============================================================================
// Mutex on the registry file.
// ============================================================================

let registryWrite: Promise<void> = Promise.resolve()

const withRegistryMutex = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prev = registryWrite
  let release!: () => void
  const next = new Promise<void>((resolve) => { release = resolve })
  registryWrite = prev.then(() => next)
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

// ============================================================================
// File I/O
// ============================================================================

const ensureDir = async (dir: string): Promise<void> => {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true, mode: 0o700 })
}

const readRegistryFile = async (): Promise<CategoryRegistryFile> => {
  const path = registryPath()
  if (!existsSync(path)) {
    return { version: REGISTRY_VERSION, categories: [] }
  }
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as Partial<CategoryRegistryFile>
  if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.categories)) {
    throw new Error(`malformed categories.json at ${path} (expected version ${REGISTRY_VERSION})`)
  }
  return { version: REGISTRY_VERSION, categories: parsed.categories }
}

const writeRegistryFile = async (file: CategoryRegistryFile): Promise<void> => {
  const path = registryPath()
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

// ============================================================================
// Validation
// ============================================================================

export interface ValidationError { readonly field: string; readonly message: string }

export const validateCategoryMeta = (raw: unknown): { ok: true; meta: CategoryMeta } | { ok: false; errors: ReadonlyArray<ValidationError> } => {
  const errors: ValidationError[] = []
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: [{ field: '', message: 'category must be an object' }] }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ID_PATTERN.test(r.id)) {
    errors.push({ field: 'id', message: `id must match /${ID_PATTERN.source}/ (got ${JSON.stringify(r.id)})` })
  }
  if (typeof r.displayName !== 'string' || r.displayName.trim().length === 0) {
    errors.push({ field: 'displayName', message: 'displayName must be a non-empty string' })
  }
  if (!isMarkerIcon(r.icon)) {
    errors.push({ field: 'icon', message: `icon must be one of the marker icon names (got ${JSON.stringify(r.icon)})` })
  }
  if (r.osmQuery !== undefined) {
    if (typeof r.osmQuery !== 'string' || r.osmQuery.trim().length === 0) {
      errors.push({ field: 'osmQuery', message: 'osmQuery must be a non-empty string when present' })
    } else {
      const matches = r.osmQuery.match(/\{name\}/g)
      if (!matches || matches.length !== 1) {
        errors.push({ field: 'osmQuery', message: 'osmQuery must contain `{name}` placeholder exactly once' })
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  const meta: CategoryMeta = {
    id: r.id as string,
    displayName: (r.displayName as string).trim(),
    icon: r.icon as CategoryMeta['icon'],
    ...(typeof r.osmQuery === 'string' ? { osmQuery: r.osmQuery } : {}),
    ...(typeof r.addedAt === 'string' ? { addedAt: r.addedAt } : { addedAt: new Date().toISOString() }),
  }
  return { ok: true, meta }
}

// ============================================================================
// Public API — registry operations.
// ============================================================================

export const loadRegistry = async (): Promise<ReadonlyArray<CategoryMeta>> => {
  const file = await readRegistryFile()
  return file.categories
}

export const getCategory = async (id: string): Promise<CategoryMeta | null> => {
  const all = await loadRegistry()
  return all.find((c) => c.id === id) ?? null
}

export const listCategories = async (): Promise<ReadonlyArray<CategoryMeta>> =>
  loadRegistry()

// Insert or replace by id. Validation is the caller's responsibility — pass
// a result of validateCategoryMeta() through. Returns { created: boolean }.
export const upsertCategory = async (meta: CategoryMeta): Promise<{ created: boolean }> =>
  withRegistryMutex(async () => {
    const file = await readRegistryFile()
    let created = true
    const next = file.categories.map((c) => {
      if (c.id === meta.id) {
        created = false
        // Preserve addedAt on update.
        return { ...meta, addedAt: c.addedAt ?? meta.addedAt }
      }
      return c
    })
    if (created) next.push(meta)
    await writeRegistryFile({ version: REGISTRY_VERSION, categories: next })
    return { created }
  })

// Delete the registry entry, then best-effort unlink the per-category file.
// Order matters: registry-first means a crash mid-delete leaves an orphan
// .geojson file (harmless) rather than a phantom registry entry pointing
// at nothing.
export const deleteCategory = async (id: string): Promise<{ deleted: boolean; fileUnlinked: boolean }> =>
  withRegistryMutex(async () => {
    const file = await readRegistryFile()
    const idx = file.categories.findIndex((c) => c.id === id)
    if (idx === -1) return { deleted: false, fileUnlinked: false }
    const next = file.categories.filter((_, i) => i !== idx)
    await writeRegistryFile({ version: REGISTRY_VERSION, categories: next })
    let fileUnlinked = false
    try {
      await unlink(categoryFilePath(id))
      fileUnlinked = true
    } catch {
      // File may not exist (category was empty) or unlink may fail —
      // either way the registry is the source of truth. Leave the orphan;
      // a future reconciliation pass can clean it up.
    }
    return { deleted: true, fileUnlinked }
  })

// Test-only — reset internal state.
export const __resetCategoryRegistryState = (): void => {
  registryWrite = Promise.resolve()
}
