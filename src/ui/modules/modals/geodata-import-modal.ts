// ============================================================================
// Geodata Import modal — single-step paste flow.
//
// The user gets:
//   1. A copy-pasteable prompt template they can give to any AI agent.
//   2. A Task line they can edit inline (it shows up at the bottom of the
//      copied prompt).
//   3. A paste textarea for the JSON the AI returns.
//   4. One Import button: validates and applies in one click. Errors are
//      reported per-row; partial success is allowed (good rows in, bad
//      rows in the summary).
//
// The marker-icon list inside the prompt is sourced from MARKER_ICONS in
// src/ui/modules/map/normalise.ts so we never drift between renderer and
// validator.
// ============================================================================

import { createModal } from '../modals/detail-modal.ts'
import { showToast } from '../toast.ts'
import { MARKER_ICONS } from '../map/normalise.ts'

const promptTemplate = (task: string): string => `You are populating a category in the samsinn geodata system. Output ONE JSON object exactly matching the schema below — no Markdown fences, no commentary, no surrounding prose.

Schema:
{
  "category": {
    "id": "<kebab-case unique id>",
    "displayName": "<Title Case>",
    "icon": ${MARKER_ICONS.map((i) => `"${i}"`).join(' | ')},
    "osmQuery": "<optional Overpass query template using {name} placeholder; omit if not relevant>"
  },
  "features": [{
    "id": "<unique kebab-case>",
    "name": "<display name>",
    "aliases": ["<alt names or codes>"],
    "lat": <number>,
    "lng": <number>,
    "country": "<ISO 3166-1 alpha-2>",
    "operator": "<optional operating org>",
    "tags": ["<optional>"]
  }]
}

Rules:
- Coordinates MUST be decimal degrees, not DMS.
- Use real coordinates from public sources — DO NOT invent.
- If you cannot find at least 5 real entries, return {"error": "<reason>"} and nothing else.
- "category" can also be a string id (e.g. "wind-farm") instead of an object — that means "append features to this existing category".

Task: ${task || '<describe the dataset, e.g. "all wind farms in the North Sea Norwegian sector">'}`

interface ImportResultPayload {
  ok: boolean
  categoryAction: 'created' | 'metadata-replaced' | 'append-only' | 'aborted'
  categoryId: string | null
  featuresAdded: number
  featuresReplaced: number
  errors: ReadonlyArray<{ index: number; field?: string; message: string }>
}

const submitImport = async (paste: string): Promise<ImportResultPayload | { networkError: string }> => {
  let body: unknown
  try { body = JSON.parse(paste) }
  catch (err) {
    return { ok: false, categoryAction: 'aborted', categoryId: null, featuresAdded: 0, featuresReplaced: 0, errors: [{ index: -1, message: `paste is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }] }
  }
  try {
    const res = await fetch('/api/geodata/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json() as ImportResultPayload
  } catch (err) {
    return { networkError: err instanceof Error ? err.message : String(err) }
  }
}

const renderResult = (resultEl: HTMLElement, r: ImportResultPayload | { networkError: string }): void => {
  if ('networkError' in r) {
    resultEl.innerHTML = `<div class="text-xs text-red-400">Network error: ${r.networkError}</div>`
    return
  }
  const tag = r.ok
    ? '<span class="px-1 py-0.5 rounded bg-green-900/30 text-green-300 text-[10px]">ok</span>'
    : '<span class="px-1 py-0.5 rounded bg-red-900/30 text-red-300 text-[10px]">aborted</span>'
  const lines: string[] = []
  lines.push(`<div class="text-xs">${tag} category <span class="font-mono">${r.categoryId ?? '—'}</span> · action: <span class="font-mono">${r.categoryAction}</span> · added ${r.featuresAdded}, replaced ${r.featuresReplaced}</div>`)
  if (r.errors.length > 0) {
    lines.push('<div class="text-xs text-yellow-300 mt-2">Errors:</div>')
    lines.push('<ul class="text-[11px] text-text-muted ml-4 list-disc">')
    for (const e of r.errors.slice(0, 20)) {
      const where = e.index >= 0 ? `feature[${e.index}]` : 'paste'
      lines.push(`<li>${where}${e.field ? ` · ${e.field}` : ''}: ${e.message}</li>`)
    }
    if (r.errors.length > 20) lines.push(`<li>(${r.errors.length - 20} more…)</li>`)
    lines.push('</ul>')
  }
  resultEl.innerHTML = lines.join('')
}

export const openGeodataImportModal = async (onImported?: () => void): Promise<void> => {
  const modal = createModal({ title: 'Geodata — Import', width: 'max-w-3xl' })
  document.body.appendChild(modal.overlay)

  const wrapper = document.createElement('div')
  wrapper.className = 'px-6 py-4 space-y-4'
  modal.scrollBody.appendChild(wrapper)

  // --- Prompt template + copy + task line ---
  const promptBox = document.createElement('textarea')
  promptBox.className = 'w-full bg-surface-muted text-text text-[11px] font-mono px-2 py-1 rounded border border-border'
  promptBox.style.height = '180px'
  promptBox.readOnly = true

  const taskInput = document.createElement('input')
  taskInput.type = 'text'
  taskInput.placeholder = 'Task: describe what to fetch (e.g. "all wind farms in the North Sea")'
  taskInput.className = 'w-full bg-surface-muted text-text text-xs px-2 py-1 rounded border border-border'

  const refreshPrompt = (): void => { promptBox.value = promptTemplate(taskInput.value.trim()) }
  refreshPrompt()
  taskInput.oninput = refreshPrompt

  const copyBtn = document.createElement('button')
  copyBtn.className = 'text-xs px-3 py-1 rounded bg-surface-muted hover:bg-surface text-text border border-border'
  copyBtn.textContent = 'Copy prompt'
  copyBtn.onclick = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(promptBox.value)
      showToast(document.body, 'Prompt copied', { type: 'success', position: 'fixed' })
    } catch {
      showToast(document.body, 'Copy failed', { type: 'error', position: 'fixed' })
    }
  }

  wrapper.innerHTML = `<div class="text-xs text-text-muted">1. Edit the Task line, copy the prompt, give it to your AI of choice. Paste the AI's JSON response below and click Import.</div>`

  const step1 = document.createElement('div')
  step1.className = 'space-y-2'
  const taskLabel = document.createElement('div')
  taskLabel.className = 'text-xs text-text-muted'
  taskLabel.textContent = 'Task'
  step1.appendChild(taskLabel)
  step1.appendChild(taskInput)
  step1.appendChild(promptBox)
  const copyRow = document.createElement('div')
  copyRow.className = 'flex justify-end'
  copyRow.appendChild(copyBtn)
  step1.appendChild(copyRow)
  wrapper.appendChild(step1)

  // --- Paste box + Import ---
  const pasteLabel = document.createElement('div')
  pasteLabel.className = 'text-xs text-text-muted mt-4'
  pasteLabel.textContent = '2. Paste the AI\'s JSON response'
  wrapper.appendChild(pasteLabel)

  const pasteBox = document.createElement('textarea')
  pasteBox.className = 'w-full bg-surface-muted text-text text-[11px] font-mono px-2 py-1 rounded border border-border'
  pasteBox.style.height = '200px'
  pasteBox.placeholder = '{ "category": {...}, "features": [...] }'
  wrapper.appendChild(pasteBox)

  const importBtn = document.createElement('button')
  importBtn.className = 'text-xs px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white'
  importBtn.textContent = 'Import'

  const importRow = document.createElement('div')
  importRow.className = 'flex justify-end'
  importRow.appendChild(importBtn)
  wrapper.appendChild(importRow)

  const resultEl = document.createElement('div')
  resultEl.className = 'mt-2 px-3 py-2 rounded bg-surface-muted/40'
  wrapper.appendChild(resultEl)

  importBtn.onclick = async (): Promise<void> => {
    const paste = pasteBox.value.trim()
    if (!paste) {
      resultEl.innerHTML = '<div class="text-xs text-yellow-300">Paste the AI response above first.</div>'
      return
    }
    importBtn.disabled = true
    importBtn.textContent = 'Importing…'
    try {
      const r = await submitImport(paste)
      renderResult(resultEl, r)
      if (!('networkError' in r) && r.ok) {
        if (onImported) onImported()
      }
    } finally {
      importBtn.disabled = false
      importBtn.textContent = 'Import'
    }
  }
}
