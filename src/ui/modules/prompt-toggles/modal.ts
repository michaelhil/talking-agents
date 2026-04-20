// ============================================================================
// Section-preview modal. Opens on the 🔍 button next to each toggle row.
// ============================================================================

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const openModal = (title: string, body: string, tokenEstimate: number): void => {
  const backdrop = document.createElement('div')
  backdrop.className = 'fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4'
  const panel = document.createElement('div')
  panel.className = 'bg-white rounded shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col'
  panel.innerHTML = `
    <div class="flex items-center justify-between px-4 py-3 border-b">
      <div>
        <div class="font-semibold text-sm">${escapeHtml(title)}</div>
        <div class="text-xs text-gray-500">~${tokenEstimate} tok · ${body.length} chars</div>
      </div>
      <button class="text-gray-400 hover:text-gray-700 text-lg leading-none" aria-label="Close">×</button>
    </div>
    <pre class="p-4 text-xs font-mono whitespace-pre-wrap overflow-auto flex-1">${escapeHtml(body || '(empty)')}</pre>
  `
  const close = (): void => { backdrop.remove() }
  panel.querySelector('button')!.addEventListener('click', close)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc) }
  })
  backdrop.appendChild(panel)
  document.body.appendChild(backdrop)
}
