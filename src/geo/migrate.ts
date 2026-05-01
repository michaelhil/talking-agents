// One-shot migration for the user-definable categories refactor.
//
// Pre-refactor layout:
//   ~/.samsinn/geodata/airport.geojson, city.geojson, offshore-platform.geojson, ...
//   ~/.samsinn/geodata/.bundled/0.1.0/...    ← cached jsdelivr snapshot (also obsolete)
//
// Post-refactor layout:
//   ~/.samsinn/geodata/categories.json       ← registry of user-defined categories
//   ~/.samsinn/geodata/<category-id>.geojson ← one file per category
//
// Detection: the absence of categories.json AND presence of any *.geojson
// files in the geodata dir. Run once at boot. Idempotent: a fresh install
// has no .geojson files; a migrated install has categories.json.
//
// Decision (per Q1 in the stress-test): wipe everything. The user opted
// for a clean break. Affected files are deleted, the .bundled cache is
// removed, an empty categories.json is written. One log line.

import { existsSync } from 'node:fs'
import { readdir, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { sharedPaths } from '../core/paths.ts'

const REGISTRY_FILE = 'categories.json'

export interface MigrationResult {
  readonly migrated: boolean
  readonly filesRemoved: number
  readonly bundledRemoved: boolean
}

export const runGeodataMigrationOnce = async (): Promise<MigrationResult> => {
  const root = sharedPaths.geodata()
  if (!existsSync(root)) return { migrated: false, filesRemoved: 0, bundledRemoved: false }
  if (existsSync(join(root, REGISTRY_FILE))) {
    return { migrated: false, filesRemoved: 0, bundledRemoved: false }
  }

  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return { migrated: false, filesRemoved: 0, bundledRemoved: false }
  }

  let filesRemoved = 0
  let bundledRemoved = false
  for (const e of entries) {
    if (e === REGISTRY_FILE) continue
    const path = join(root, e)
    if (e === '.bundled') {
      try { await rm(path, { recursive: true, force: true }); bundledRemoved = true }
      catch { /* harmless */ }
      continue
    }
    if (!e.endsWith('.geojson')) continue
    try { await unlink(path); filesRemoved++ }
    catch { /* harmless */ }
  }

  const acted = filesRemoved > 0 || bundledRemoved
  if (acted) {
    console.log(`[geo/migrate] cleared pre-registry layout: ${filesRemoved} .geojson file(s)${bundledRemoved ? ' + .bundled cache' : ''}`)
  }
  return { migrated: acted, filesRemoved, bundledRemoved }
}
