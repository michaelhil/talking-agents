// ============================================================================
// Packs panel — sidebar section listing installed packs with per-pack
// update/uninstall buttons and a header "+" that prompts for install source.
//
// Re-renders on:
//   - initial sidebar expand
//   - `packs-changed` custom event (fired by ws-dispatch on packs_changed)
//
// No polling — packs mutate rarely enough that the WS broadcast is enough.
// ============================================================================

import { domRefs } from './app-dom.ts'
import { showToast } from './toast.ts'

interface InstalledPack {
  namespace: string
  dirPath: string
  manifest: { name?: string; description?: string }
  tools: string[]
  skills: string[]
}

const fetchPacks = async (): Promise<InstalledPack[]> => {
  try {
    const res = await fetch('/api/packs')
    if (!res.ok) return []
    return await res.json() as InstalledPack[]
  } catch { return [] }
}

const renderPacksList = async (): Promise<void> => {
  const packs = await fetchPacks()
  domRefs.packsList.innerHTML = ''

  if (packs.length === 0) {
    domRefs.packsList.innerHTML = '<div class="text-xs text-text-muted px-3 py-1">No packs installed</div>'
    return
  }

  for (const pack of packs) {
    const row = document.createElement('div')
    row.className = 'px-3 py-1 text-xs hover:bg-surface-muted flex items-center gap-1'
    const label = pack.manifest.name ?? pack.namespace
    const desc = pack.manifest.description ?? ''
    const counts = `${pack.tools.length} tool${pack.tools.length === 1 ? '' : 's'}, ${pack.skills.length} skill${pack.skills.length === 1 ? '' : 's'}`
    row.innerHTML = `
      <div class="flex-1 min-w-0 truncate" title="${desc || counts}">
        <span class="text-text-strong">${label}</span>
        <span class="text-text-muted"> · ${counts}</span>
      </div>
      <button class="pack-update text-text-subtle hover:text-text" title="Update (git pull)">↻</button>
      <button class="pack-uninstall text-text-subtle hover:text-danger" title="Uninstall">✕</button>
    `
    row.querySelector<HTMLButtonElement>('.pack-update')?.addEventListener('click', async () => {
      showToast(document.body, `${pack.namespace}: updating…`, { position: 'fixed' })
      const res = await fetch(`/api/packs/update/${encodeURIComponent(pack.namespace)}`, { method: 'POST' })
      const ok = res.ok
      showToast(document.body, `${pack.namespace}: ${ok ? 'updated' : 'update failed'}`, {
        type: ok ? 'success' : 'error', position: 'fixed',
      })
    })
    row.querySelector<HTMLButtonElement>('.pack-uninstall')?.addEventListener('click', async () => {
      if (!confirm(`Uninstall pack "${pack.namespace}"? Its tools and skills will be unregistered.`)) return
      const res = await fetch(`/api/packs/${encodeURIComponent(pack.namespace)}`, { method: 'DELETE' })
      const ok = res.ok
      showToast(document.body, `${pack.namespace}: ${ok ? 'uninstalled' : 'uninstall failed'}`, {
        type: ok ? 'success' : 'error', position: 'fixed',
      })
    })
    domRefs.packsList.appendChild(row)
  }
}

const promptInstall = async (): Promise<void> => {
  const source = prompt(
    'Install pack from:\n\n' +
    '  name                → github.com/samsinn-packs/<name>\n' +
    '  user/repo           → github.com/user/repo\n' +
    '  https://...         → full URL',
    '',
  )?.trim()
  if (!source) return

  showToast(document.body, `Installing ${source}…`, { position: 'fixed' })
  const res = await fetch('/api/packs/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'install failed' })) as { error?: string }
    showToast(document.body, `Install failed: ${body.error ?? 'unknown'}`, { type: 'error', position: 'fixed' })
    return
  }
  const data = await res.json() as { namespace: string; tools: string[]; skills: string[] }
  showToast(
    document.body,
    `${data.namespace}: ${data.tools.length} tools, ${data.skills.length} skills`,
    { type: 'success', position: 'fixed' },
  )
}

let loaded = false
let changeListener: ((ev: Event) => void) | null = null

export const initPacksPanel = (): void => {
  const { packsHeader, packsList, packsToggle } = domRefs

  const updateLabel = (expanded: boolean): void => {
    packsToggle.textContent = `${expanded ? '▾' : '▸'} Packs`
  }

  packsHeader.onclick = async (e) => {
    if ((e.target as HTMLElement).closest('button[data-packs-action]')) return
    const nowHidden = packsList.classList.toggle('hidden')
    updateLabel(!nowHidden)
    if (!nowHidden && !loaded) {
      loaded = true
      await renderPacksList()
    }
  }

  const installBtn = document.getElementById('btn-install-pack')
  if (installBtn) {
    installBtn.onclick = (e) => { e.stopPropagation(); void promptInstall() }
  }

  // WS-driven refresh: re-render whenever packs change (install/update/uninstall).
  if (!changeListener) {
    changeListener = () => {
      if (loaded) void renderPacksList()
    }
    window.addEventListener('packs-changed', changeListener)
  }
}
