// UI extension mount layer (Path C).
//
// A pack declares `ui_extensions: ["biometrics"]` in its pack.json. The server
// surfaces this verbatim in /api/packs (list_packs tool response). The browser
// unions the declared names across installed packs and reconciles them against
// KNOWN_UI_EXTENSIONS — mounting / unmounting as the union changes.
//
// Path C invariants:
//   - The pack contributes only the *declaration*. The implementation lives
//     in core, gated on the declaration.
//   - Server has no authority over the name set; the browser silently no-ops
//     on unknown names so a pack can declare an extension before any core
//     release knows about it (forward-compat).
//   - mount() is async because v1 lazy-imports heavy modules (widget + panel)
//     so the user pays nothing for unused extensions.
//   - unmount() must release every resource the extension acquired —
//     post-render processors, settings panels, in-flight captures, etc.
//
// Adding a new extension to KNOWN_UI_EXTENSIONS is the only change required
// in this file when a new module ships. The corresponding pack just declares
// the matching name.

import {
  addPostRenderProcessor,
  removePostRenderProcessor,
  type PostRenderProcessor,
} from './post-render-registry.ts'

export interface PanelSpec {
  readonly id: string
  readonly title: string
  readonly mount: (host: HTMLElement) => void
  readonly unmount?: () => void
}

export interface ExtensionAPI {
  readonly addPostRenderProcessor: (name: string, fn: PostRenderProcessor) => void
  readonly removePostRenderProcessor: (name: string) => void
  readonly registerPanel: (spec: PanelSpec) => () => void
}

export interface UIExtension {
  readonly name: string
  readonly mount: (api: ExtensionAPI) => Promise<void>
  readonly unmount: () => Promise<void>
}

// Panel registration is lightweight — the panel renderer (Settings nav) polls
// this list. Keeps the API surface in this file rather than reaching into
// settings-nav internals from extension code.
interface PanelEntry {
  readonly id: string
  readonly title: string
  readonly mount: (host: HTMLElement) => void
  readonly unmount?: () => void
}
const panels = new Map<string, PanelEntry>()

export const listExtensionPanels = (): ReadonlyArray<PanelEntry> => [...panels.values()]

const buildApi = (): ExtensionAPI => ({
  addPostRenderProcessor,
  removePostRenderProcessor,
  registerPanel: (spec) => {
    panels.set(spec.id, spec)
    notifyPanelsChanged()
    return () => {
      const e = panels.get(spec.id)
      try { e?.unmount?.() } catch { /* ignore */ }
      panels.delete(spec.id)
      notifyPanelsChanged()
    }
  },
})

const panelsChangedListeners = new Set<() => void>()
const notifyPanelsChanged = (): void => {
  for (const l of panelsChangedListeners) {
    try { l() } catch { /* ignore */ }
  }
}
export const onExtensionPanelsChanged = (cb: () => void): (() => void) => {
  panelsChangedListeners.add(cb)
  return () => panelsChangedListeners.delete(cb)
}

// === Known extensions ========================================================
// Each entry is a thunk returning a UIExtension. The thunk is invoked lazily
// the first time the extension is mounted, so the import graph for unused
// extensions stays cold. v1 lazy-imports the heavy modules inside mount().
type ExtensionThunk = () => Promise<UIExtension>

const KNOWN_UI_EXTENSIONS: Record<string, ExtensionThunk> = {
  biometrics: async () => (await import('./biometrics.ts')).createBiometricsExtension(),
}

// === Reconciliation ==========================================================

interface MountedEntry {
  readonly extension: UIExtension
}
const mounted = new Map<string, MountedEntry>()

// Reconcile mounted extensions against the declared set from the server.
// Idempotent — calling with the same set twice is a no-op.
export const reconcileExtensions = async (declared: ReadonlySet<string>): Promise<void> => {
  // Unmount what's mounted but no longer declared.
  for (const [name, entry] of mounted) {
    if (!declared.has(name)) {
      try { await entry.extension.unmount() } catch (err) {
        console.error(`[extensions] ${name}: unmount failed`, err)
      }
      mounted.delete(name)
    }
  }
  // Mount what's declared but not mounted. Silently skip unknown names —
  // forward-compat with packs declaring future extensions.
  for (const name of declared) {
    if (mounted.has(name)) continue
    const thunk = KNOWN_UI_EXTENSIONS[name]
    if (!thunk) continue
    try {
      const extension = await thunk()
      await extension.mount(buildApi())
      mounted.set(name, { extension })
    } catch (err) {
      console.error(`[extensions] ${name}: mount failed`, err)
    }
  }
}

// Pull the declared set from the /api/packs response. Reads pack entries'
// ui_extensions arrays and unions them. System packs (core/local) don't
// declare extensions; only user-installed packs can.
export const fetchDeclaredExtensions = async (): Promise<ReadonlySet<string>> => {
  try {
    const res = await fetch('/api/packs')
    if (!res.ok) return new Set()
    const body = await res.json() as Array<{ ui_extensions?: ReadonlyArray<string> }>
    const set = new Set<string>()
    for (const p of body) {
      for (const name of p.ui_extensions ?? []) set.add(name)
    }
    return set
  } catch {
    return new Set()
  }
}

// Convenience: fetch + reconcile in one call. Used at boot and on every
// `packs_changed` WS event.
export const refreshExtensions = async (): Promise<void> => {
  await reconcileExtensions(await fetchDeclaredExtensions())
}
