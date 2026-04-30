// Toast notifications — brief messages anchored to a DOM element or the
// viewport. Click to dismiss. Errors stay visible longer than success
// toasts (errors typically carry detail the user needs to read).

export interface ToastOptions {
  readonly type?: 'success' | 'error'
  readonly position?: 'relative' | 'fixed'
  readonly durationMs?: number
}

export const showToast = (
  anchor: HTMLElement,
  message: string,
  options?: ToastOptions,
): void => {
  const type = options?.type ?? 'success'
  const position = options?.position ?? 'relative'
  const defaultMs = type === 'error' ? 8000 : 3000
  const durationMs = options?.durationMs ?? defaultMs
  const toast = document.createElement('div')

  if (position === 'fixed') {
    toast.className = `fixed top-4 right-4 ${type === 'success' ? 'bg-success' : 'bg-danger-hover'} text-white text-xs px-4 py-2 rounded shadow-lg z-50 transition-opacity duration-700 max-w-md cursor-pointer`
    // HTML5 <dialog> opened with showModal() lives in the browser top-layer
    // and obscures elements appended to body — even position:fixed; z-index:50.
    // If a modal dialog is open, append the toast inside it so it joins the
    // same top-layer. Falls back to body when no modal is open.
    const openDialog = Array.from(document.querySelectorAll('dialog'))
      .find(d => d.open && d.matches(':modal')) as HTMLDialogElement | undefined
    ;(openDialog ?? document.body).appendChild(toast)
  } else {
    toast.className = `absolute left-1/2 -translate-x-1/2 ${type === 'success' ? 'bg-success' : 'bg-danger-hover'} text-white text-xs px-3 py-1 rounded shadow transition-opacity duration-700 cursor-pointer`
    toast.style.bottom = '4px'
    anchor.appendChild(toast)
  }

  toast.textContent = message
  toast.title = 'click to dismiss'
  toast.addEventListener('click', () => toast.remove(), { once: true })
  const fadeAt = Math.max(500, durationMs - 700)
  setTimeout(() => { toast.style.opacity = '0' }, fadeAt)
  setTimeout(() => { toast.remove() }, durationMs)
}
