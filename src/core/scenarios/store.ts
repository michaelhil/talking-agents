// ============================================================================
// Scenario store — discovers scenarios from installed packs + bundled
// synthetic packs (welcome) + user-authored scenarios under baseDir.
// Mirrors the script-store pattern.
//
// Layout per pack:
//   <packDir>/scenarios/<name>/scenario.md   ← preferred
//   <packDir>/scenarios/<name>.md            ← flat
//
// User-authored (write_scenario tool):
//   <baseDir>/<name>/scenario.md             ← preferred (matches pack layout)
//   <baseDir>/<name>.md                      ← flat
// User-authored scenarios are tagged with pack=LOCAL_SCENARIO_PACK ('local')
// matching the script-runner convention for unsourced content.
//
// Bundled synthetic scenarios are registered at construction via
// `extraSources` — used by the welcome pack which lives in the source tree
// rather than under SAMSINN_HOME/packs.
// ============================================================================

import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Scenario } from './types.ts'
import { parseScenario, VALID_NAME } from './parser.ts'
import { assertDemoIsHandsFree } from './assertions.ts'
import { scanMarkdownDir } from '../markdown-fs.ts'
import { createSerialiseChain } from '../serialise-chain.ts'

export const MAX_SCENARIO_SOURCE_BYTES = 256 * 1024
// User-authored scenarios live under baseDir and are tagged with this
// synthetic pack namespace (matches the script-runner convention).
export const LOCAL_SCENARIO_PACK = 'local'

export interface ExtraSource {
  readonly pack: string
  readonly scenarios: ReadonlyArray<{ readonly name: string; readonly source: string }>
}

export interface ScenarioStore {
  readonly get: (id: string) => Scenario | undefined
  readonly list: () => ReadonlyArray<Scenario>
  readonly listForPack: (pack: string) => ReadonlyArray<Scenario>
  readonly reload: () => Promise<ReadonlyArray<string>>
  // upsert/remove operate on baseDir only — bundled and pack-installed
  // scenarios are read-only from the store API. Throws if baseDir is unset.
  readonly upsert: (name: string, source: string) => Promise<Scenario>
  readonly remove: (name: string) => Promise<boolean>
  readonly onChange: (fn: () => void) => () => void
}

export interface ScenarioStoreInit {
  // Per-pack `scenarios/` directories. Resolved per reload so pack
  // install/uninstall picks up changes.
  readonly resolvePackDirs?: () => Promise<ReadonlyArray<{ readonly pack: string; readonly dir: string }>>
  // Bundled synthetic scenarios — welcome pack lives here. A function so
  // bundled sources that depend on per-System state (e.g. the welcome pack
  // resolves the default model from live provider state) can be lazily
  // computed after System construction completes.
  readonly extraSources?: () => ReadonlyArray<ExtraSource>
  // Optional base directory for user-authored scenarios. When set, upsert
  // writes here and reload includes them under LOCAL_SCENARIO_PACK. Omit
  // (e.g. headless tests) to disable user-authored scenarios.
  readonly baseDir?: string
}

export const createScenarioStore = (init: ScenarioStoreInit): ScenarioStore => {
  const { resolvePackDirs, extraSources, baseDir } = init
  const scenarios = new Map<string, Scenario>()
  const listeners = new Set<() => void>()
  // Serialises upsert/remove/reload so concurrent writes can't interleave
  // their fs+memory state. Same pattern as the script store.
  const chain = createSerialiseChain()

  const fireChange = (): void => {
    for (const fn of listeners) {
      try { fn() } catch { /* listener errors must not break the store */ }
    }
  }

  const reloadInternal = async (): Promise<ReadonlyArray<string>> => {
    const merged = new Map<string, Scenario>()

    // Bundled synthetic scenarios first — same id-collision rule as packs.
    const bundled = extraSources ? extraSources() : []
    for (const src of bundled) {
      for (const { name, source } of src.scenarios) {
        try {
          const parsed = parseScenario(src.pack, name, source)
          assertDemoIsHandsFree(parsed)
          if (merged.has(parsed.id)) {
            console.warn(`[scenarios] duplicate id "${parsed.id}" — second occurrence wins`)
          }
          merged.set(parsed.id, parsed)
        } catch (err) {
          console.warn(
            `[scenarios] bundled "${src.pack}/${name}" invalid — ${err instanceof Error ? err.message : err}`,
          )
        }
      }
    }

    // User-authored scenarios under baseDir — tagged as pack='local'.
    if (baseDir) {
      const local = await scanPackScenarios(LOCAL_SCENARIO_PACK, baseDir)
      for (const s of local) {
        if (merged.has(s.id)) {
          console.warn(`[scenarios] local id collision for "${s.id}" — first wins`)
          continue
        }
        merged.set(s.id, s)
      }
    }

    if (resolvePackDirs) {
      const packDirs = await resolvePackDirs()
      for (const { pack, dir } of packDirs) {
        const loaded = await scanPackScenarios(pack, dir)
        for (const s of loaded) {
          if (merged.has(s.id)) {
            console.warn(`[scenarios] id collision for "${s.id}" — first wins`)
            continue
          }
          merged.set(s.id, s)
        }
      }
    }

    scenarios.clear()
    for (const [id, s] of merged) scenarios.set(id, s)
    fireChange()
    return [...scenarios.keys()]
  }

  const reload = (): Promise<ReadonlyArray<string>> => chain.run(reloadInternal)

  const upsert = (name: string, source: string): Promise<Scenario> => chain.run(async () => {
    if (!baseDir) {
      throw new Error('upsert requires a baseDir; this scenario store is read-only')
    }
    if (!VALID_NAME.test(name)) {
      throw new Error(`scenario name must match ${VALID_NAME} (got "${name}")`)
    }
    if (source.length > MAX_SCENARIO_SOURCE_BYTES) {
      throw new Error(`scenario source too large: ${source.length} bytes (max ${MAX_SCENARIO_SOURCE_BYTES})`)
    }
    // Validate before write — bad source rejected with line context.
    parseScenario(LOCAL_SCENARIO_PACK, name, source)
    const dir = join(baseDir, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'scenario.md'), source, 'utf-8')
    await reloadInternal()
    // Scenarios are id-keyed (parser builds id as `${pack}:${name}` typically).
    // Find the freshly-loaded one by name match within the local pack.
    const local = [...scenarios.values()].find(s => s.pack === LOCAL_SCENARIO_PACK && s.name === name)
    if (!local) throw new Error(`upsert: scenario "${name}" did not reload`)
    return local
  })

  const remove = (name: string): Promise<boolean> => chain.run(async () => {
    if (!baseDir) return false
    if (!VALID_NAME.test(name)) return false
    const dir = join(baseDir, name)
    const flat = join(baseDir, `${name}.md`)
    let removed = false
    try { await rm(dir, { recursive: true, force: true }); removed = true } catch { /* may not exist */ }
    try { await rm(flat, { force: true }); removed = removed || true } catch { /* may not exist */ }
    if (removed) await reloadInternal()
    return removed
  })

  const onChange = (fn: () => void): (() => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  return {
    get: (id) => scenarios.get(id),
    list: () => [...scenarios.values()],
    listForPack: (pack) => [...scenarios.values()].filter(s => s.pack === pack),
    reload,
    upsert,
    remove,
    onChange,
  }
}

// === Filesystem scan ===
//
// Delegates to the shared scanMarkdownDir helper. Differs from the script
// store only in the `pack` namespace tag baked into each parsed Scenario.

const scanPackScenarios = async (pack: string, dir: string): Promise<ReadonlyArray<Scenario>> => {
  const results = await scanMarkdownDir<Scenario>({
    dir,
    innerFilename: 'scenario.md',
    validNameRe: VALID_NAME,
    logPrefix: 'scenarios',
    maxBytes: MAX_SCENARIO_SOURCE_BYTES,
    parse: (name, raw) => {
      const parsed = parseScenario(pack, name, raw)
      assertDemoIsHandsFree(parsed)
      return parsed
    },
  })
  return results.map(r => r.value)
}
