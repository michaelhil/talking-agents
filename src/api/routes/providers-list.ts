// GET /api/providers — provider status list (never returns raw keys).
//
// Combines the on-disk providers store, env-var fallback (mergeWithEnv),
// and the live monitor snapshot into a stable shape the UI renders
// top-to-bottom in router order.

import { json } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import {
  loadProviderStore, mergeWithEnv,
} from '../../llm/providers-store.ts'
import {
  PROVIDER_PROFILES, type CloudProviderName, isLocal,
} from '../../llm/providers-config.ts'
import type { MonitorState, MonitorSubState, FailureRecord } from '../../llm/provider-monitor.ts'

// Legacy 4-value status surfaced to existing UI code that hasn't yet been
// updated to consume the richer monitor sub-state. The monitor's sub-state
// is also returned in `monitor` so new UI can use it directly.
type ProviderStatus = 'ok' | 'no_key' | 'cooldown' | 'down' | 'disabled'

interface ProviderStatusEntry {
  readonly name: string
  readonly kind: 'cloud' | 'ollama'
  readonly keyMask: string
  readonly source: 'env' | 'stored' | 'none'
  readonly enabled: boolean            // effective (has key AND userEnabled)
  readonly userEnabled: boolean        // user intent, independent of key
  readonly hasKey: boolean
  // Local providers (llamacpp): URL-configurable, no key required. UI uses
  // this flag to render a URL field instead of a key field on the row.
  readonly isLocal: boolean
  readonly baseUrl?: string
  readonly maxConcurrent: number | null
  readonly cooldown: { readonly coldUntilMs: number; readonly reason: string } | null
  readonly status: ProviderStatus
  // Full monitor state — Phase 2/3 UI will render directly from this.
  readonly monitor: {
    readonly sub: MonitorSubState
    readonly reason: string
    readonly retryAt: number | null
    readonly modelCount: number
    readonly consecutiveFailures: number
    readonly lastError: { code: string; message: string } | null
    readonly lastErrorAt: number | null
  } | null
  readonly recentFailures: ReadonlyArray<FailureRecord>
}

const subToLegacyStatus = (sub: MonitorSubState | null): ProviderStatus => {
  if (sub === null) return 'ok'
  if (sub === 'no_key') return 'no_key'
  if (sub === 'disabled') return 'disabled'
  if (sub === 'down' || sub === 'unhealthy') return 'down'
  if (sub === 'backoff') return 'cooldown'
  return 'ok'
}

const monitorToLegacyCooldown = (
  m: MonitorState | null,
): { coldUntilMs: number; reason: string } | null => {
  if (!m || m.sub !== 'backoff' || m.retryAt === null) return null
  return { coldUntilMs: m.retryAt, reason: m.reason }
}

export const providersListRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/providers$/,
    handler: async (_req, _match, { system }) => {
      const { data: store, warnings } = await loadProviderStore(system.providersStorePath)
      const merged = mergeWithEnv(store)
      const monitorSnap = system.llm.getMonitorSnapshot()
      const monitors = system.monitors ?? {}
      const activeOrder = system.llm.getOrder()
      const orderLockedByEnv = !!process.env.PROVIDER_ORDER

      const byName = new Map<string, ProviderStatusEntry>()

      const monitorPayload = (mon: MonitorState | null): ProviderStatusEntry['monitor'] =>
        mon
          ? {
              sub: mon.sub,
              reason: mon.reason,
              retryAt: mon.retryAt,
              modelCount: mon.modelCount,
              consecutiveFailures: mon.consecutiveFailures,
              lastError: mon.lastError,
              lastErrorAt: mon.lastErrorAt,
            }
          : null

      for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
        const m = merged.cloud[name]
        if (!m) continue
        const hasKey = m.apiKey.length > 0
        const userEnabled = system.providerKeys.isUserEnabled(name)
        const monState = monitorSnap[name] ?? null
        const failures = monitors[name]?.getRecentFailures() ?? []
        const local = isLocal(name)
        byName.set(name, {
          name, kind: 'cloud',
          keyMask: m.maskedKey,
          source: m.source,
          hasKey,
          isLocal: local,
          ...(local ? { baseUrl: m.baseUrl ?? PROVIDER_PROFILES[name].baseUrl } : {}),
          userEnabled,
          // Local providers are "enabled" once user-enabled — no key required.
          enabled: local ? userEnabled : (hasKey && userEnabled),
          maxConcurrent: m.maxConcurrent ?? PROVIDER_PROFILES[name].defaultMaxConcurrent,
          cooldown: monitorToLegacyCooldown(monState),
          // Status mapping: local providers can't be 'no_key' (don't need one).
          status: !userEnabled
            ? 'disabled'
            : (!hasKey && !local)
              ? 'no_key'
              : subToLegacyStatus(monState?.sub ?? null),
          monitor: monitorPayload(monState),
          recentFailures: failures,
        })
      }

      // Ollama — no key concept, but still has a user-enabled toggle.
      const ollamaUserEnabled = merged.ollama.enabled
      const ollamaMon = monitorSnap.ollama ?? null
      const ollamaFailures = monitors.ollama?.getRecentFailures() ?? []
      byName.set('ollama', {
        name: 'ollama', kind: 'ollama',
        keyMask: '',
        source: 'none',
        hasKey: true,
        isLocal: true,
        userEnabled: ollamaUserEnabled,
        enabled: ollamaUserEnabled,
        maxConcurrent: merged.ollama.maxConcurrent ?? 2,
        cooldown: monitorToLegacyCooldown(ollamaMon),
        status: !ollamaUserEnabled ? 'disabled' : subToLegacyStatus(ollamaMon?.sub ?? null),
        monitor: monitorPayload(ollamaMon),
        recentFailures: ollamaFailures,
      })

      // Emit in router order so the UI can just render top-to-bottom.
      const entries: ProviderStatusEntry[] = []
      for (const name of activeOrder) {
        const entry = byName.get(name)
        if (entry) entries.push(entry)
      }

      return json({
        providers: entries,
        activeOrder,
        orderLockedByEnv,
        droppedFromOrder: system.providerConfig.droppedFromOrder,
        forceFailProvider: system.providerConfig.forceFailProvider,
        storeWarnings: warnings,
      })
    },
  },
]
