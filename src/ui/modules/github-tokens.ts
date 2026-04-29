// ============================================================================
// GitHub-tokens editor — small UI section for the SAMSINN_PACK_REGISTRY_TOKEN
// / SAMSINN_WIKI_REGISTRY_TOKEN slots. Mounted inside Packs and Wikis panels.
//
// Mirrors the providers admin UI: never shows raw key, masked display only,
// edit + clear actions. Save → server invalidates the matching discovery
// cache so the next list call retries authenticated.
// ============================================================================

import { showToast } from './toast.ts'

type Slot = 'packRegistry' | 'wikiRegistry'

interface TokenState {
  hasKey: boolean
  source: 'env' | 'stored' | 'none'
  maskedKey: string
  envVar: string
}

interface AllTokens {
  packRegistry: TokenState
  wikiRegistry: TokenState
}

const fetchTokens = async (): Promise<AllTokens | null> => {
  try {
    const res = await fetch('/api/github-tokens')
    if (!res.ok) return null
    return await res.json() as AllTokens
  } catch { return null }
}

const saveToken = async (
  slot: Slot,
  apiKey: string | null,
): Promise<{ ok: true; data: AllTokens } | { ok: false; error: string }> => {
  try {
    const res = await fetch(`/api/github-tokens/${slot}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'save failed' })) as { error?: string }
      return { ok: false, error: body.error ?? `HTTP ${res.status}` }
    }
    return { ok: true, data: await res.json() as AllTokens }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// Render the editor for one slot. Caller mounts in their panel; both panels
// reuse this so styling stays consistent.
export const renderGithubTokenEditor = async (
  container: HTMLElement,
  slot: Slot,
): Promise<void> => {
  const tokens = await fetchTokens()
  container.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'border-t border-border'
  container.appendChild(wrap)

  const header = document.createElement('div')
  header.className = 'px-3 py-2 text-[11px] uppercase tracking-wide text-text-subtle bg-surface-muted flex items-center justify-between'
  header.innerHTML = `<span>GitHub access token</span><span class="text-[10px] normal-case tracking-normal text-text-muted">Lifts the 60/hr unauthenticated rate limit to 5000/hr.</span>`
  wrap.appendChild(header)

  if (!tokens) {
    const err = document.createElement('div')
    err.className = 'px-3 py-2 text-xs text-danger italic'
    err.textContent = 'Could not load token state.'
    wrap.appendChild(err)
    return
  }

  const state = tokens[slot]

  const row = document.createElement('div')
  row.className = 'px-3 py-2 text-xs flex items-center gap-2 border-b border-border'

  const label = document.createElement('span')
  label.className = 'flex-1'
  if (state.source === 'env') {
    label.innerHTML = `<span class="font-mono">${escapeHtml(state.maskedKey)}</span> <span class="ml-1 text-[10px] uppercase tracking-wide text-text-subtle" title="From ${escapeHtml(state.envVar)} env — edit your env to change">from env</span>`
  } else if (state.source === 'stored') {
    label.innerHTML = `<span class="font-mono">${escapeHtml(state.maskedKey)}</span>`
  } else {
    label.innerHTML = `<span class="text-text-muted italic">none configured (60/hr GitHub limit applies)</span>`
  }
  row.appendChild(label)

  // When env wins, the UI cannot override (env always takes precedence). Show
  // a disabled-looking edit hint instead of an editable button.
  if (state.source === 'env') {
    const note = document.createElement('span')
    note.className = 'text-[10px] text-text-subtle'
    note.textContent = 'unset env to edit here'
    row.appendChild(note)
  } else {
    const editBtn = document.createElement('button')
    editBtn.className = 'px-2 py-1 text-xs bg-accent text-white rounded hover:opacity-90'
    editBtn.textContent = state.source === 'stored' ? 'Replace' : 'Set token'
    editBtn.onclick = async () => {
      const next = prompt(
        `Paste a GitHub personal access token with broad public read scope.\n\n` +
        `Used only for ${slot === 'packRegistry' ? 'pack' : 'wiki'} registry discovery.\n` +
        `Stored at ~/.samsinn/github-tokens.json (mode 0600).`,
      )?.trim()
      if (!next) return
      const result = await saveToken(slot, next)
      if (result.ok === false) {
        showToast(document.body, `Save failed: ${result.error}`, { type: 'error', position: 'fixed' })
        return
      }
      showToast(document.body, 'Token saved.', { type: 'success', position: 'fixed' })
      await renderGithubTokenEditor(container, slot)
    }
    row.appendChild(editBtn)

    if (state.source === 'stored') {
      const clearBtn = document.createElement('button')
      clearBtn.className = 'text-text-subtle hover:text-danger'
      clearBtn.title = 'Clear stored token'
      clearBtn.setAttribute('aria-label', 'Clear stored token')
      clearBtn.textContent = '×'
      clearBtn.onclick = async () => {
        if (!confirm('Clear the stored token? This drops the file entry; env still wins if set.')) return
        const result = await saveToken(slot, null)
        if (result.ok === false) {
          showToast(document.body, `Clear failed: ${result.error}`, { type: 'error', position: 'fixed' })
          return
        }
        await renderGithubTokenEditor(container, slot)
      }
      row.appendChild(clearBtn)
    }
  }

  wrap.appendChild(row)

  // Help link — github.com docs for creating fine-grained / classic PATs.
  const help = document.createElement('div')
  help.className = 'px-3 py-1 text-[11px] text-text-muted'
  help.innerHTML = `<a href="https://github.com/settings/tokens" target="_blank" rel="noopener" class="hover:underline">Create a token at github.com/settings/tokens →</a>`
  wrap.appendChild(help)
}
