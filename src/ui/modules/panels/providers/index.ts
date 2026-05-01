// ============================================================================
// Providers panel — unified list of all providers (cloud + ollama) with
// per-provider key management, reorder arrows, and Ollama settings expander.
//
// The server returns providers in current router order. Arrows let the user
// promote/demote each provider; new order is sent via PUT /api/providers/order
// and takes effect live (no restart). Ollama settings (connection, models,
// gateway config) live inside the Ollama row's expandable details.
//
// Poll-driven: refreshes /api/providers every 10s while the dashboard is open.
// Also re-renders immediately on the `providers-changed` custom event
// (fired by ws-dispatch on providers_changed broadcasts).
// ============================================================================

import { showToast } from '../../toast.ts'
import { openModelsPopover } from '../../models-popover.ts'
import { save, saveOrder, testKey, formatTestToast } from './api.ts'
import { renderRow, renderFailuresSection, type ProviderStatusEntry } from './row.ts'

interface ProvidersResponse {
  providers: ProviderStatusEntry[]
  activeOrder: string[]
  orderLockedByEnv: boolean
  droppedFromOrder: string[]
  forceFailProvider: string | null
  storeWarnings: string[]
}

// The Ollama settings element is reparented into the Ollama row's holder
// on each render. Before destroying rows, return it to the dialog body so
// the next render can find it again.
const detachOllamaSettings = (): void => {
  const settings = document.getElementById('ollama-settings')
  const dialogBody = document.querySelector('#ollama-dashboard > div')
  if (settings && dialogBody && settings.parentElement !== dialogBody) {
    settings.classList.add('hidden')
    dialogBody.appendChild(settings)
  }
}

// Shared max-concurrent blur handler. Both cloud + Ollama rows save on blur
// when the value has changed from its original; logic is identical so it
// lives here rather than being duplicated per-branch.
const attachMaxConcurrentBlur = (row: HTMLElement, name: string): void => {
  const mc = row.querySelector<HTMLInputElement>(`#prov-mc-${name}`)
  if (!mc) return
  mc.addEventListener('blur', async () => {
    if ((mc.dataset.original ?? '') === mc.value) return
    const n = parseInt(mc.value, 10)
    if (!Number.isFinite(n) || n <= 0) return
    const ok = await save(name, { maxConcurrent: n })
    showToast(document.body, ok
      ? `${name}: concurrency updated`
      : `${name}: save failed`,
      { type: ok ? 'success' : 'error', position: 'fixed' })
  })
}

export const renderProvidersPanel = (list: ProvidersResponse): void => {
  const container = document.getElementById('providers-list')
  if (!container) return

  detachOllamaSettings()
  container.innerHTML = ''

  const notice = document.getElementById('order-locked-notice')
  if (notice) notice.classList.toggle('hidden', !list.orderLockedByEnv)

  if (list.providers.length === 0) {
    container.innerHTML = '<div class="text-text-muted italic">No providers configured.</div>'
    return
  }

  const orderNames = list.activeOrder
  const moveUp = (name: string) => {
    const idx = orderNames.indexOf(name)
    if (idx <= 0) return
    const next = [...orderNames]
    ;[next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!]
    void saveOrder(next).then(ok => {
      if (!ok) showToast(document.body, `Failed to reorder`, { type: 'error', position: 'fixed' })
    })
  }
  const moveDown = (name: string) => {
    const idx = orderNames.indexOf(name)
    if (idx < 0 || idx >= orderNames.length - 1) return
    const next = [...orderNames]
    ;[next[idx], next[idx + 1]] = [next[idx + 1]!, next[idx]!]
    void saveOrder(next).then(ok => {
      if (!ok) showToast(document.body, `Failed to reorder`, { type: 'error', position: 'fixed' })
    })
  }

  list.providers.forEach((entry, i) => {
    const row = renderRow({
      entry,
      position: { isFirst: i === 0, isLast: i === list.providers.length - 1 },
      orderLocked: list.orderLockedByEnv,
    })
    container.appendChild(row)

    // Persisted failures live inline under the row so the user doesn't
    // have to remember which provider produced which transient toast.
    const failuresEl = renderFailuresSection(entry)
    if (failuresEl) container.appendChild(failuresEl)

    // For Ollama: a full-width sibling container below the row holds the
    // settings panel. The Settings button in the row toggles its visibility.
    if (entry.kind === 'ollama') {
      const settingsHolder = document.createElement('div')
      settingsHolder.className = 'hidden w-full pl-8 pr-2 py-2'
      settingsHolder.dataset.ollamaSettingsHolder = '1'
      container.appendChild(settingsHolder)

      const settings = document.getElementById('ollama-settings')
      if (settings) {
        settings.classList.remove('hidden')
        settingsHolder.appendChild(settings)
      }

      row.querySelector<HTMLButtonElement>('.ollama-settings-btn')?.addEventListener('click', () => {
        settingsHolder.classList.toggle('hidden')
      })
    }

    // Arrows
    row.querySelector<HTMLButtonElement>('.prov-up')?.addEventListener('click', () => moveUp(entry.name))
    row.querySelector<HTMLButtonElement>('.prov-down')?.addEventListener('click', () => moveDown(entry.name))

    // Models popover
    const modelsBtn = row.querySelector<HTMLButtonElement>('.prov-models-btn')
    modelsBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      void openModelsPopover(modelsBtn, entry.name)
    })

    // Status dot click → toggle user-enabled (requires a key, unless Ollama)
    row.querySelector<HTMLButtonElement>('.prov-dot-btn')?.addEventListener('click', async () => {
      if (entry.kind === 'cloud' && !entry.hasKey) {
        showToast(document.body, `Paste an ${entry.name} key first`, { type: 'error', position: 'fixed' })
        return
      }
      const nextEnabled = !entry.userEnabled
      const ok = await save(entry.name, { enabled: nextEnabled })
      if (!ok) {
        showToast(document.body, `${entry.name}: failed to ${nextEnabled ? 'enable' : 'disable'}`, { type: 'error', position: 'fixed' })
      }
      // `providers_changed` broadcast (fired by the PUT handler) will trigger
      // the panel to re-render with the new status.
    })

    // max-concurrent blur save (shared between cloud + Ollama)
    attachMaxConcurrentBlur(row, entry.name)

    // Ollama Test button: ping + concurrency probe.
    if (entry.kind === 'ollama') {
      row.querySelector<HTMLButtonElement>('.prov-test')?.addEventListener('click', async () => {
        showToast(document.body, `ollama: testing…`, { position: 'fixed' })
        const result = await testKey('ollama')
        showToast(document.body, formatTestToast('ollama', result), { type: result.ok ? 'success' : 'error', position: 'fixed' })
      })
    }

    // Local-provider URL-field blur + test button. Shares kind=='cloud' with
    // real cloud providers but renders/saves a baseUrl instead of an apiKey.
    if (entry.isLocal) {
      const urlField = row.querySelector<HTMLInputElement>(`#prov-url-${entry.name}`)
      urlField?.addEventListener('blur', async () => {
        const original = urlField.dataset.original ?? ''
        const current = urlField.value.trim()
        if (current === original) return
        // Empty value clears (server falls back to PROVIDER_PROFILES default).
        const ok = await save(entry.name, { baseUrl: current === '' ? null : current })
        showToast(document.body, ok
          ? `${entry.name}: URL ${current === '' ? 'reset to default' : 'updated'}`
          : `${entry.name}: URL save failed`,
          { type: ok ? 'success' : 'error', position: 'fixed' })
      })
      // Test button — same probe path the cloud branch uses.
      row.querySelector<HTMLButtonElement>('.prov-test')?.addEventListener('click', async () => {
        showToast(document.body, `${entry.name}: testing…`, { position: 'fixed' })
        const result = await testKey(entry.name)
        showToast(document.body, formatTestToast(entry.name, result), { type: result.ok ? 'success' : 'error', position: 'fixed' })
      })
      return  // skip the cloud-key path below
    }

    // Cloud-provider key-field blur + test button.
    if (entry.kind === 'cloud') {
      const keyField = row.querySelector<HTMLInputElement>(`#prov-key-${entry.name}`)

      keyField?.addEventListener('blur', async () => {
        const original = keyField.dataset.original ?? ''
        const current = keyField.value
        if (current === original) return

        const trimmed = current.trim()
        if (trimmed === '') {
          // Empty / whitespace → clear the stored key.
          const ok = await save(entry.name, { apiKey: null })
          showToast(document.body, ok
            ? `${entry.name}: key cleared`
            : `${entry.name}: clear failed`,
            { type: ok ? 'success' : 'error', position: 'fixed' })
          return
        }

        // New value — save, then test the stored key end-to-end.
        const savedOk = await save(entry.name, { apiKey: trimmed })
        if (!savedOk) {
          showToast(document.body, `${entry.name}: save failed`, { type: 'error', position: 'fixed' })
          return
        }
        const result = await testKey(entry.name)
        if (result.ok) {
          showToast(document.body, `${entry.name}: saved & verified — ${result.modelCount ?? 0} models · ${result.elapsedMs}ms`, { type: 'success', position: 'fixed' })
        } else {
          showToast(document.body, `${entry.name}: saved — test failed: ${result.error ?? 'unknown'}`, { type: 'error', position: 'fixed' })
        }
      })

      // Test button: models-ping + concurrency probe. If the user has typed
      // an unsaved key, we test that one; otherwise the stored key.
      row.querySelector<HTMLButtonElement>('.prov-test')?.addEventListener('click', async () => {
        const typed = keyField?.value.trim()
        const original = keyField?.dataset.original ?? ''
        const pending = typed && typed !== original ? typed : undefined
        showToast(document.body, `${entry.name}: testing…`, { position: 'fixed' })
        const result = await testKey(entry.name, pending)
        showToast(document.body, formatTestToast(entry.name, result), { type: result.ok ? 'success' : 'error', position: 'fixed' })
      })
    }
  })

  // Store warnings
  if (list.storeWarnings.length > 0) {
    const warn = document.createElement('div')
    warn.className = 'text-[11px] text-warning bg-warning-bg border border-warning-border rounded px-2 py-1 mt-1'
    warn.textContent = list.storeWarnings.join(' · ')
    container.appendChild(warn)
  }
}

// --- Poll loop + lifecycle ---

let pollTimer: number | undefined
let changeListener: ((ev: Event) => void) | null = null

const refresh = async (): Promise<void> => {
  try {
    const res = await fetch('/api/providers')
    if (!res.ok) return
    const data = await res.json() as ProvidersResponse
    renderProvidersPanel(data)
  } catch { /* ignore transient fetch errors */ }
}

// Run /api/providers/:name/test for every provider currently shown, in
// sequence (avoid hammering all upstreams in parallel). Each result pushes
// into the monitor (server-side) and triggers a providers_changed broadcast,
// so the panel rerenders automatically — no manual refresh needed here.
//
// The summary toast carries per-provider detail — caller wants to know
// *which* provider failed and *why*, not just an aggregate "x/y failed"
// count. One toast per provider would flood the screen, so we collapse
// into one toast with multiple lines.
const testAll = async (): Promise<void> => {
  const btn = document.getElementById('providers-test-all') as HTMLButtonElement | null
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…' }
  try {
    const res = await fetch('/api/providers')
    if (!res.ok) return
    const data = await res.json() as ProvidersResponse
    const lines: string[] = []
    let okCount = 0, failCount = 0, skipCount = 0
    for (const p of data.providers) {
      if (p.kind === 'cloud' && !p.hasKey) {
        lines.push(`• ${p.name}: skipped (no API key)`)
        skipCount++
        continue
      }
      let result
      try {
        result = await testKey(p.name)
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: 0 } as const
      }
      const tag = result.ok ? '✓' : '✗'
      // Reuse the same one-line formatter the per-row Test button uses so
      // detail (concurrency capacity / latency / model count) stays
      // consistent across both call sites. Errors are truncated to keep
      // the toast a sensible size when many providers fail at once.
      const detail = formatTestToast(p.name, result).replace(/^[^:]+:\s*/, '')
      lines.push(`${tag} ${p.name}: ${detail.length > 90 ? detail.slice(0, 90) + '…' : detail}`)
      if (result.ok) okCount++
      else failCount++
    }
    const header = `Tested ${okCount + failCount + skipCount} providers — ${okCount} ok, ${failCount} failed${skipCount ? `, ${skipCount} skipped` : ''}`
    // Multi-line via \n + the toast's whitespace handling. The toast
    // container already has max-w-md so long lines wrap; the duration is
    // bumped so the user has time to read each line.
    showToast(document.body, `${header}\n${lines.join('\n')}`, {
      type: failCount === 0 ? 'success' : 'error',
      position: 'fixed',
      durationMs: Math.min(20_000, 4_000 + lines.length * 1_500),
    })
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test all' }
    // Force one final refresh in case the WS broadcast was missed.
    await refresh()
  }
}

export const startProvidersPanel = async (): Promise<void> => {
  await refresh()
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(() => { void refresh() }, 10_000)

  // React to live provider changes (key add/remove, reorder) without waiting
  // for the next poll tick. ws-dispatch dispatches this from providers_changed
  // broadcasts.
  if (!changeListener) {
    changeListener = () => { void refresh() }
    window.addEventListener('providers-changed', changeListener)
  }

  // Wire the Test-all header button. Idempotent — replaceWith clears any
  // listener attached on a previous open.
  const oldBtn = document.getElementById('providers-test-all')
  if (oldBtn) {
    const fresh = oldBtn.cloneNode(true) as HTMLButtonElement
    oldBtn.parentNode?.replaceChild(fresh, oldBtn)
    fresh.addEventListener('click', () => { void testAll() })
  }
}

export const stopProvidersPanel = (): void => {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
  if (changeListener) {
    window.removeEventListener('providers-changed', changeListener)
    changeListener = null
  }
  detachOllamaSettings()
}
