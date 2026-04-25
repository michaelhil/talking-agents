// ============================================================================
// Bug report modal — POST /api/bugs creates a GitHub issue server-side.
//
// Reachable from two surfaces (both wired in app.ts / settings-nav.ts):
//   - Bug icon in the room header (#btn-report-bug)
//   - "Report bug" entry in the Settings sidebar
//
// Auto-attached context: samsinn version (from /api/system/info) + browser
// userAgent. Never includes room/agent/message content. The user-typed
// description is the only free text — it goes through verbatim.
// ============================================================================

import { showToast } from './toast.ts'

interface SystemInfo { readonly version: string }

let cachedVersion: string | null = null

const fetchVersion = async (): Promise<string> => {
  if (cachedVersion !== null) return cachedVersion
  try {
    const res = await fetch('/api/system/info')
    if (!res.ok) return ''
    const info = await res.json() as Partial<SystemInfo>
    cachedVersion = info.version ?? ''
    return cachedVersion
  } catch { return '' }
}

export const openBugModal = async (): Promise<void> => {
  const dlg = document.getElementById('bug-modal') as HTMLDialogElement | null
  if (!dlg) return
  const form = document.getElementById('bug-form') as HTMLFormElement
  const titleEl = document.getElementById('bug-title') as HTMLInputElement
  const descEl = document.getElementById('bug-description') as HTMLTextAreaElement
  const ctxEl = document.getElementById('bug-context') as HTMLElement
  const closeBtn = document.getElementById('bug-close') as HTMLButtonElement
  const cancelBtn = document.getElementById('bug-cancel') as HTMLButtonElement
  const submitBtn = document.getElementById('bug-submit') as HTMLButtonElement

  // Reset form on every open.
  titleEl.value = ''
  descEl.value = ''
  submitBtn.disabled = false

  const version = await fetchVersion()
  const ua = navigator.userAgent
  ctxEl.textContent = `Will include: samsinn ${version || '(version unknown)'} · ${ua}`

  closeBtn.onclick = () => dlg.close()
  cancelBtn.onclick = () => dlg.close()
  dlg.addEventListener('cancel', () => dlg.close())

  form.onsubmit = async (e) => {
    e.preventDefault()
    const title = titleEl.value.trim()
    const description = descEl.value.trim()
    if (!title || !description) return
    submitBtn.disabled = true
    try {
      const res = await fetch('/api/bugs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, version, userAgent: ua }),
      })
      if (res.status === 201) {
        const body = await res.json().catch(() => ({})) as { htmlUrl?: string; number?: number }
        dlg.close()
        const msg = body.htmlUrl
          ? `Reported as #${body.number ?? '?'} — view on GitHub`
          : 'Bug reported, thanks!'
        showToast(document.body, msg, { type: 'success', position: 'fixed' })
        // Open the issue link in a new tab if available — without
        // requiring a click on the toast (which auto-fades).
        if (body.htmlUrl) window.open(body.htmlUrl, '_blank', 'noopener')
        return
      }

      const detail = await res.json().catch(() => ({})) as { error?: string }
      const errMsg = detail.error ?? `Submit failed (${res.status})`
      if (res.status === 503) {
        showToast(document.body, errMsg, { type: 'error', position: 'fixed' })
      } else if (res.status === 429) {
        showToast(document.body, errMsg, { type: 'error', position: 'fixed' })
      } else {
        showToast(document.body, errMsg, { type: 'error', position: 'fixed' })
      }
    } catch {
      showToast(document.body, 'Submit failed (network)', { type: 'error', position: 'fixed' })
    } finally {
      submitBtn.disabled = false
    }
  }

  if (!dlg.open) dlg.showModal()
}
