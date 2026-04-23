// ============================================================================
// Ollama Dashboard — health, metrics, model management, URL switching.
//
// Extracted from app.ts. All Ollama-specific DOM manipulation lives here.
// ============================================================================

// === Types ===

export interface OllamaDashboardElements {
  readonly statusDot: HTMLElement
  readonly dashboard: HTMLDialogElement
  readonly closeBtn: HTMLButtonElement
  readonly urlSelect: HTMLSelectElement
  readonly urlInput: HTMLInputElement
  readonly btnUrlAdd: HTMLElement
  readonly btnUrlDelete: HTMLElement
}

// === Status dot colors ===

const statusColors: Record<string, string> = {
  healthy: 'bg-success',
  degraded: 'bg-thinking',
  down: 'bg-danger',
}

// === Health UI ===

export const updateOllamaHealthUI = (
  health: Record<string, unknown>,
  statusDot: HTMLElement,
): void => {
  const status = health.status as string ?? 'down'
  statusDot.className = `inline-block w-2 h-2 rounded-full ${statusColors[status] ?? 'bg-text-muted'}`

  // Update dashboard if open
  const dotEl = document.getElementById('od-status-dot')
  const textEl = document.getElementById('od-status-text')
  const latencyEl = document.getElementById('od-latency')
  if (dotEl) dotEl.className = `inline-block w-3 h-3 rounded-full ${statusColors[status] ?? 'bg-text-muted'}`
  if (textEl) textEl.textContent = status.charAt(0).toUpperCase() + status.slice(1)
  if (latencyEl) latencyEl.textContent = `${health.latencyMs ?? 0}ms`

  // Show/hide reset circuit breaker button
  const resetBtn = document.getElementById('od-reset-circuit')
  if (resetBtn) {
    resetBtn.classList.toggle('hidden', status === 'healthy')
  }

  const modelsEl = document.getElementById('od-models')
  const loaded = health.loadedModels as Array<{ name: string; sizeVram: number }> ?? []
  if (modelsEl) {
    if (loaded.length === 0) {
      modelsEl.textContent = 'No models loaded'
    } else {
      modelsEl.innerHTML = loaded.map(m => {
        const sizeMb = Math.round(m.sizeVram / 1e6)
        return `<div class="flex items-center justify-between py-0.5"><span class="font-mono text-xs">${m.name}</span><span class="text-xs text-text-muted">${sizeMb}MB<button class="od-unload text-xs text-danger hover:text-danger-hover ml-2" data-model="${m.name}">unload</button></span></div>`
      }).join('')
      modelsEl.querySelectorAll('.od-unload').forEach(btn => {
        btn.addEventListener('click', async () => {
          const model = (btn as HTMLElement).dataset.model
          if (model) await fetch(`/api/ollama/models/${encodeURIComponent(model)}/unload`, { method: 'POST' })
        })
      })
    }

    // Load model controls
    const loadedNames = new Set(loaded.map(m => m.name))
    const available = health.availableModels as string[] ?? []
    const unloaded = available.filter(m => !loadedNames.has(m))
    let loadRow = modelsEl.querySelector('.od-load-row') as HTMLElement | null
    if (!loadRow) {
      loadRow = document.createElement('div')
      loadRow.className = 'od-load-row flex items-center gap-1 mt-2 pt-2 border-t border-border'
      modelsEl.appendChild(loadRow)
    }
    if (unloaded.length > 0) {
      loadRow.innerHTML = `<select class="od-load-select flex-1 text-xs border rounded px-1 py-0.5">${unloaded.map(m => `<option value="${m}">${m}</option>`).join('')}</select><button class="od-load-btn text-xs px-2 py-0.5 bg-accent text-white rounded hover:bg-accent-hover">Load</button>`
      loadRow.querySelector('.od-load-btn')?.addEventListener('click', async () => {
        const sel = loadRow!.querySelector('.od-load-select') as HTMLSelectElement
        if (sel?.value) await fetch(`/api/ollama/models/${encodeURIComponent(sel.value)}/load`, { method: 'POST' })
      })
    } else {
      loadRow.innerHTML = '<span class="text-xs text-text-muted">All models loaded</span>'
    }
  }
}

// === Metrics UI ===

export const updateOllamaMetricsUI = (metrics: Record<string, unknown>): void => {
  const tpsEl = document.getElementById('od-tps')
  const p50El = document.getElementById('od-p50')
  const errorsEl = document.getElementById('od-errors')
  const queueEl = document.getElementById('od-queue')
  const concurrentEl = document.getElementById('od-concurrent')
  const circuitEl = document.getElementById('od-circuit')
  const requestsEl = document.getElementById('od-requests')
  if (tpsEl) tpsEl.textContent = `${(metrics.avgTokensPerSecond as number ?? 0).toFixed(1)}`
  if (p50El) {
    const ms = metrics.p50Latency as number ?? 0
    p50El.textContent = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
  }
  if (errorsEl) errorsEl.textContent = `${((metrics.errorRate as number ?? 0) * 100).toFixed(0)}%`
  if (queueEl) queueEl.textContent = `${metrics.queueDepth ?? 0}`
  if (concurrentEl) concurrentEl.textContent = `${metrics.concurrentRequests ?? 0}`
  if (circuitEl) {
    const state = metrics.circuitState as string ?? 'closed'
    circuitEl.textContent = state
    circuitEl.className = `text-lg font-semibold ${state === 'closed' ? 'text-success' : state === 'open' ? 'text-danger' : 'text-warning'}`
  }
  if (requestsEl) requestsEl.textContent = `${metrics.requestCount ?? 0}`
}

// === URL management ===

export const refreshOllamaUrls = async (urlSelect: HTMLSelectElement): Promise<void> => {
  const data = await fetch('/api/ollama/urls').then(r => r.ok ? r.json() : null).catch(() => null) as { current: string; saved: string[] } | null
  if (!data) return
  urlSelect.innerHTML = ''
  for (const url of data.saved) {
    const opt = document.createElement('option')
    opt.value = url
    opt.textContent = url
    if (url === data.current) opt.selected = true
    urlSelect.appendChild(opt)
  }
}

// === Wire all dashboard event handlers ===

export const wireOllamaDashboard = (
  els: OllamaDashboardElements,
  send: (data: unknown) => void,
): void => {
  // Reset circuit breaker button
  els.dashboard.querySelector('#od-reset-circuit')?.addEventListener('click', async () => {
    await fetch('/api/ollama/reset-circuit', { method: 'POST' })
  })

  els.dashboard.querySelector('#od-cfg-save')?.addEventListener('click', async () => {
    const body: Record<string, unknown> = {}
    const cfgConcurrent = document.getElementById('od-cfg-concurrent') as HTMLInputElement
    const cfgQueue = document.getElementById('od-cfg-queue') as HTMLInputElement
    const cfgTimeout = document.getElementById('od-cfg-timeout') as HTMLInputElement
    const cfgKeepalive = document.getElementById('od-cfg-keepalive') as HTMLInputElement
    if (cfgConcurrent?.value) body.maxConcurrent = parseInt(cfgConcurrent.value)
    if (cfgQueue?.value) body.maxQueueDepth = parseInt(cfgQueue.value)
    if (cfgTimeout?.value) body.queueTimeoutMs = parseInt(cfgTimeout.value)
    if (cfgKeepalive?.value) body.keepAlive = cfgKeepalive.value
    await fetch('/api/ollama/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })

  els.urlSelect.onchange = async () => {
    if (!els.urlSelect.value) return
    await fetch('/api/ollama/urls', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: els.urlSelect.value }) })
  }

  els.btnUrlAdd.onclick = async () => {
    const url = els.urlInput.value.trim()
    if (!url) return
    await fetch('/api/ollama/urls', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
    els.urlInput.value = ''
    await refreshOllamaUrls(els.urlSelect)
  }

  els.btnUrlDelete.onclick = async () => {
    const url = els.urlSelect.value
    if (!url) return
    await fetch('/api/ollama/urls', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
    await refreshOllamaUrls(els.urlSelect)
  }

  els.closeBtn.onclick = () => {
    els.dashboard.close()
    send({ type: 'unsubscribe_ollama_metrics' })
  }

  els.dashboard.addEventListener('close', () => {
    send({ type: 'unsubscribe_ollama_metrics' })
  })
}

// === Open dashboard (fetch initial data) ===

export const openOllamaDashboard = async (
  els: OllamaDashboardElements,
  send: (data: unknown) => void,
): Promise<void> => {
  els.dashboard.showModal()
  send({ type: 'subscribe_ollama_metrics' })
  void refreshOllamaUrls(els.urlSelect)

  try {
    const [healthRes, metricsRes, configRes] = await Promise.all([
      fetch('/api/ollama/health'),
      fetch('/api/ollama/metrics'),
      fetch('/api/ollama/config'),
    ])
    if (healthRes.ok) updateOllamaHealthUI(await healthRes.json() as Record<string, unknown>, els.statusDot)
    if (metricsRes.ok) updateOllamaMetricsUI(await metricsRes.json() as Record<string, unknown>)
    if (configRes.ok) {
      const cfg = await configRes.json() as Record<string, unknown>
      const cfgConcurrent = document.getElementById('od-cfg-concurrent') as HTMLInputElement
      const cfgQueue = document.getElementById('od-cfg-queue') as HTMLInputElement
      const cfgTimeout = document.getElementById('od-cfg-timeout') as HTMLInputElement
      const cfgKeepalive = document.getElementById('od-cfg-keepalive') as HTMLInputElement
      if (cfgConcurrent) cfgConcurrent.value = String(cfg.maxConcurrent ?? 2)
      if (cfgQueue) cfgQueue.value = String(cfg.maxQueueDepth ?? 6)
      if (cfgTimeout) cfgTimeout.value = String(cfg.queueTimeoutMs ?? 30000)
      if (cfgKeepalive) cfgKeepalive.value = String(cfg.keepAlive ?? '30m')
    }
  } catch { /* ignore fetch errors on dashboard open */ }
}
