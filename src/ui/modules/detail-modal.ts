// Canonical modal kit — one source of truth for:
//   - overlay + card structure (token-backed colors)
//   - fixed header (title + close)
//   - scrollable body (max-h-[90vh], overflow-y-auto, min-h-0)
//   - optional fixed footer for button rows
//   - content primitives (section labels, readonly rows, pills, code blocks)
//   - text-editor convenience (openTextEditorModal)
//
// The structured return shape replaces the old `{overlay, body, close}` API
// so every modal gets scroll-on-overflow by default — no caller can forget.

// ============================================================================
// Primitives
// ============================================================================

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const createSectionLabel = (text: string): HTMLDivElement => {
  const el = document.createElement('div')
  el.className = 'text-xs font-semibold uppercase tracking-wide mb-1 mt-3 text-text-muted'
  el.textContent = text
  return el
}

export const createReadonlyRow = (value: string, opts?: { mono?: boolean; muted?: boolean }): HTMLDivElement => {
  const el = document.createElement('div')
  const color = opts?.muted ? 'text-text-subtle' : 'text-text'
  const mono = opts?.mono ? ' font-mono' : ''
  el.className = `text-xs rounded border px-2 py-1 mb-1 bg-surface-muted border-border ${color}${mono}`
  el.textContent = value || '—'
  return el
}

export const createPillList = (
  items: ReadonlyArray<{ readonly label: string; readonly onClick?: () => void; readonly title?: string }>,
  emptyText = 'None',
): HTMLDivElement => {
  const row = document.createElement('div')
  row.className = 'flex flex-wrap gap-1 mb-1'
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'text-xs text-text-muted'
    empty.textContent = emptyText
    row.appendChild(empty)
    return row
  }
  for (const item of items) {
    const pill = document.createElement(item.onClick ? 'button' : 'span')
    pill.className = 'text-xs px-2 py-0.5 rounded-full border bg-surface border-border text-text'
    if (item.onClick) pill.classList.add('cursor-pointer', 'hover:opacity-80')
    pill.textContent = item.label
    if (item.title) pill.title = item.title
    if (item.onClick) (pill as HTMLButtonElement).onclick = item.onClick
    row.appendChild(pill)
  }
  return row
}

export const createCodeBlock = (code: string, maxHeight = '16rem'): HTMLPreElement => {
  const pre = document.createElement('pre')
  pre.className = 'text-xs font-mono p-2 rounded overflow-auto whitespace-pre bg-surface-inverse text-[#e5e7eb]'
  pre.style.maxHeight = maxHeight
  pre.textContent = code
  return pre
}

export const prettyJson = (value: unknown): string => {
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

export const createButtonRow = (
  onCancel: () => void,
  onSave: () => void,
  saveLabel = 'Save',
): HTMLDivElement => {
  const row = document.createElement('div')
  row.className = 'flex justify-end gap-2'
  const cancel = document.createElement('button')
  cancel.className = 'px-4 py-2 text-sm text-text-subtle'
  cancel.textContent = 'Cancel'
  cancel.onclick = onCancel
  const save = document.createElement('button')
  save.className = 'px-4 py-2 text-sm rounded bg-accent text-white'
  save.textContent = saveLabel
  save.onclick = onSave
  row.appendChild(cancel); row.appendChild(save)
  return row
}

// ============================================================================
// Button + Input primitives — class-driven; visual rules live in index.html
// (.btn, .btn-primary, .btn-ghost, .btn-danger, .input). Helpers below own
// the *contract* so callers don't construct elements by hand.
// ============================================================================

export type ButtonVariant = 'primary' | 'primary-pending' | 'ghost' | 'danger'

export interface ButtonOptions {
  readonly variant?: ButtonVariant   // default 'ghost'
  readonly label?: string            // text inside the button
  readonly icon?: SVGElement         // prepended before label; from icon()
  readonly title?: string            // tooltip
  readonly ariaLabel?: string        // explicit a11y label (defaults to title or label)
  readonly className?: string        // extra utility classes appended (layout helpers)
  readonly type?: 'button' | 'submit'
  readonly onClick?: (e: MouseEvent) => void
  readonly disabled?: boolean
}

export const createButton = (opts: ButtonOptions = {}): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.type = opts.type ?? 'button'
  const variant = opts.variant ?? 'ghost'
  btn.className = `btn btn-${variant}${opts.className ? ' ' + opts.className : ''}`
  if (opts.icon) btn.appendChild(opts.icon)
  if (opts.label) {
    const span = document.createElement('span')
    span.textContent = opts.label
    btn.appendChild(span)
  }
  if (opts.title) btn.title = opts.title
  const a11y = opts.ariaLabel ?? opts.title ?? opts.label
  if (a11y) btn.setAttribute('aria-label', a11y)
  if (opts.disabled) btn.disabled = true
  if (opts.onClick) btn.onclick = opts.onClick
  return btn
}

// Mutate a button's pending vs primary class — used by dirty-state save buttons.
export const setButtonPending = (btn: HTMLButtonElement, pending: boolean): void => {
  btn.classList.toggle('btn-primary-pending', pending)
  btn.classList.toggle('btn-primary', !pending)
  btn.style.cursor = pending ? 'not-allowed' : 'pointer'
}

export interface InputOptions {
  readonly placeholder?: string
  readonly value?: string
  readonly disabled?: boolean
  readonly type?: 'text' | 'number' | 'password' | 'email'
  readonly className?: string
  readonly mono?: boolean
}

export const createInput = (opts: InputOptions = {}): HTMLInputElement => {
  const el = document.createElement('input')
  el.type = opts.type ?? 'text'
  el.className = `input${opts.mono ? ' font-mono' : ''}${opts.className ? ' ' + opts.className : ''}`
  if (opts.placeholder) el.placeholder = opts.placeholder
  if (opts.value !== undefined) el.value = opts.value
  if (opts.disabled) el.disabled = true
  return el
}

export const createTextarea = (
  value: string = '',
  rows: number = 6,
  opts: { readonly className?: string } = {},
): HTMLTextAreaElement => {
  const el = document.createElement('textarea')
  el.className = `input${opts.className ? ' ' + opts.className : ''}`
  el.rows = rows
  el.value = value
  return el
}

// ============================================================================
// Modal scaffolding
// ============================================================================

export interface ModalConfig {
  readonly title: string
  readonly width?: string        // Tailwind max-w class, default 'max-w-lg'
  readonly maxHeight?: string    // CSS value, default '90vh'
}

export interface ModalElements {
  readonly overlay: HTMLDivElement       // the full-viewport click-to-close layer
  readonly card: HTMLDivElement          // the whole modal card (for rare cases)
  readonly header: HTMLDivElement        // fixed title row — append actions if needed
  readonly scrollBody: HTMLDivElement    // scrollable content — append everything here
  readonly footer: HTMLDivElement        // fixed button row — appears only if populated
  readonly close: () => void
}

// Creates a modal with fixed title + scrollable body + optional fixed footer.
// Content taller than the viewport scrolls inside scrollBody; title and footer
// stay visible. Caller appends into scrollBody (and footer if needed).
export const createModal = (config: ModalConfig): ModalElements => {
  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 flex items-center justify-center z-50 p-4'
  overlay.style.background = 'var(--shadow-overlay)'

  const card = document.createElement('div')
  card.className = `rounded-lg shadow-xl w-full ${config.width ?? 'max-w-lg'} flex flex-col overflow-hidden bg-surface text-text`
  card.style.maxHeight = config.maxHeight ?? '90vh'

  const header = document.createElement('div')
  header.className = 'flex items-center justify-between px-6 py-3 border-b border-border flex-shrink-0'
  const title = document.createElement('h3')
  title.className = 'text-lg font-semibold'
  title.textContent = config.title
  header.appendChild(title)
  const close = (): void => { overlay.remove() }
  // No × button. Click outside or Escape closes. Some callers used to look
  // it up via `header.querySelector('button')` — those have been migrated
  // to insert their own buttons before any reference, so the lookup is
  // either gone or harmless (returns the inserted button or null).

  const scrollBody = document.createElement('div')
  scrollBody.className = 'px-6 py-4 overflow-y-auto min-h-0 flex-1'

  const footer = document.createElement('div')
  footer.className = 'px-6 py-3 border-t border-border flex-shrink-0'
  footer.style.display = 'none'  // hidden until caller appends something
  // Expose helper behavior: mutations to footer auto-show it
  const observer = new MutationObserver(() => {
    footer.style.display = footer.childNodes.length > 0 ? 'block' : 'none'
  })
  observer.observe(footer, { childList: true })

  card.appendChild(header)
  card.appendChild(scrollBody)
  card.appendChild(footer)
  overlay.appendChild(card)

  overlay.onclick = (e) => { if (e.target === overlay) close() }

  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc) }
  }
  document.addEventListener('keydown', onEsc)

  return { overlay, card, header, scrollBody, footer, close }
}

// ============================================================================
// Master / detail modal — left list + right detail pane, sharing one header
// and footer. Single source of truth for the "list-then-inspect" pattern
// used by Tools and Skills so future lists don't re-derive the flex layout
// (and don't fall victim to Tailwind utilities missing from the compiled
// CSS — all critical layout dimensions here are inline styles).
// ============================================================================

export interface MasterDetailModalConfig {
  readonly title: string
  readonly masterWidth?: string      // CSS value, default '18rem'
  readonly width?: string            // Tailwind max-w class, default 'max-w-4xl'
  readonly height?: string           // CSS value, default '75vh' — master-detail
                                     //   needs a substantial canvas regardless of
                                     //   detail content height, or the list column
                                     //   collapses with the flex-1 scrollBody.
  readonly maxHeight?: string        // default '90vh'
}

export interface MasterDetailElements extends ModalElements {
  readonly master: HTMLDivElement    // append list rows here
  readonly detail: HTMLDivElement    // swap detail content here
}

export const createMasterDetailModal = (config: MasterDetailModalConfig): MasterDetailElements => {
  const modal = createModal({
    title: config.title,
    width: config.width ?? 'max-w-4xl',
    maxHeight: config.maxHeight,
  })

  // Fixed canvas height so the master list has room even when the detail
  // pane is empty or short. Without this the card sizes to content and the
  // flex-1 scrollBody collapses with no children to stretch it.
  modal.card.style.height = config.height ?? '75vh'

  // Neutralise the default scrollBody chrome so it hosts a side-by-side layout.
  modal.scrollBody.className = 'flex-1 flex overflow-hidden'
  modal.scrollBody.style.minHeight = '0'

  const master = document.createElement('div')
  master.className = 'border-r border-border flex flex-col'
  master.style.flex = `0 0 ${config.masterWidth ?? '18rem'}`
  master.style.minHeight = '0'
  master.style.overflow = 'hidden'

  const detail = document.createElement('div')
  detail.className = 'flex flex-col'
  detail.style.flex = '1 1 0'
  detail.style.minWidth = '0'
  detail.style.minHeight = '0'
  detail.style.overflow = 'auto'

  modal.scrollBody.appendChild(master)
  modal.scrollBody.appendChild(detail)

  return { ...modal, master, detail }
}

// Read-only preview modal: show a title + token estimate + pre-formatted body.
// Used by the prompt-toggles magnifier buttons.
export const openPreviewModal = (title: string, body: string, tokenEstimate: number): void => {
  const modal = createModal({ title, width: 'max-w-2xl' })
  const meta = document.createElement('div')
  meta.className = 'text-xs mb-2 text-text-muted'
  meta.textContent = `~${tokenEstimate} tok · ${body.length} chars`
  modal.scrollBody.appendChild(meta)
  const pre = document.createElement('pre')
  pre.className = 'text-xs font-mono whitespace-pre-wrap text-text'
  pre.textContent = body || '(empty)'
  modal.scrollBody.appendChild(pre)
  document.body.appendChild(modal.overlay)
}

// Convenience: fetch a JSON document, open a modal with a textarea bound to
// one field, save on confirm. Used by system-prompt + room-prompt editors.
export const openTextEditorModal = (
  title: string,
  fetchUrl: string,
  fieldName: string,
  saveUrl: string,
  method = 'PUT',
  extractValue?: (data: Record<string, unknown>) => string,
): void => {
  fetch(fetchUrl)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (!data) return
      const currentValue = extractValue
        ? extractValue(data as Record<string, unknown>)
        : ((data[fieldName] ?? '') as string)
      const modal = createModal({ title })
      const textarea = createTextarea(currentValue)
      modal.scrollBody.appendChild(textarea)
      const buttons = createButtonRow(
        modal.close,
        () => {
          fetch(saveUrl, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [fieldName]: textarea.value }),
          }).catch(() => {})
          modal.close()
        },
      )
      modal.footer.appendChild(buttons)
      document.body.appendChild(modal.overlay)
      textarea.focus()
    })
    .catch(() => {})
}
