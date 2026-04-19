// ============================================================================
// Provider keys — in-memory registry of current API keys, mutable at runtime.
//
// Built once at boot from the merged env+store config. The PUT /api/providers
// handler calls `set()` to apply new keys without restarting. The OAI-compat
// adapter reads keys via a getter closure (see openai-compatible.ts) so each
// HTTP request uses the current value.
//
// A provider is considered "enabled" iff its current key is non-empty. For
// env-sourced keys this is effectively immutable (set() still works but the
// UI disables editing in that case).
// ============================================================================

import type { CloudProviderName } from './providers-config.ts'
import type { MergedProviders } from './providers-store.ts'

export interface ProviderKeys {
  readonly get: (name: string) => string
  readonly set: (name: string, key: string) => void
  // True iff the provider has both a key AND isn't user-disabled.
  readonly isEnabled: (name: string) => boolean
  // User-disable dimension — reflects the stored enabled flag only.
  // Independent of key presence (so the UI can show "disabled, has key").
  readonly isUserEnabled: (name: string) => boolean
  readonly setEnabled: (name: string, enabled: boolean) => void
  readonly list: () => ReadonlyArray<{ name: string; enabled: boolean; userEnabled: boolean }>
}

interface Entry { apiKey: string; userEnabled: boolean }

export const createProviderKeys = (initial: MergedProviders): ProviderKeys => {
  const state = new Map<string, Entry>()
  for (const [name, entry] of Object.entries(initial.cloud)) {
    const apiKey = entry?.apiKey ?? ''
    // userEnabled defaults to TRUE unless the provider has a stored/env key
    // and is explicitly disabled. A provider with no source hasn't been
    // configured yet — it's "enabled in intent" so that pasting a key
    // activates it immediately without the user having to click the dot.
    const userEnabled = (entry?.source === 'stored' || entry?.source === 'env')
      ? (entry.enabled ?? true)
      : true
    state.set(name, { apiKey, userEnabled })
  }

  const get = (name: string): Entry => state.get(name) ?? { apiKey: '', userEnabled: true }

  return {
    get: (name) => get(name).apiKey,
    set: (name, key) => {
      const prev = get(name)
      state.set(name, { ...prev, apiKey: key })
    },
    isEnabled: (name) => {
      const e = get(name)
      return e.apiKey.length > 0 && e.userEnabled
    },
    isUserEnabled: (name) => get(name).userEnabled,
    setEnabled: (name, enabled) => {
      const prev = get(name)
      state.set(name, { ...prev, userEnabled: enabled })
    },
    list: () => Array.from(state.entries()).map(([name, e]) => ({
      name: name as CloudProviderName,
      enabled: e.apiKey.length > 0 && e.userEnabled,
      userEnabled: e.userEnabled,
    })),
  }
}
