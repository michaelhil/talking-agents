// Mermaid rendering — lazy-loads mermaid.js on first encounter. Replaces
// ```mermaid code blocks with rendered SVG, and renders standalone source
// into a container (for the mermaid artifact type).
//
// Each rendered container stores its source on `data-mermaid-source` so
// re-rendering on theme change can reuse it without re-parsing markdown.

let mermaidReady: Promise<void> | null = null
let mermaidRenderCount = 0

type MermaidApi = {
  render: (id: string, source: string) => Promise<{ svg: string }>
  initialize: (config: Record<string, unknown>) => void
}

const mermaidThemeForCurrentMode = (): string =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'neutral'

export const ensureMermaid = (): Promise<void> => {
  if (mermaidReady) return mermaidReady
  mermaidReady = import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
    .then((m: { default: MermaidApi }) => {
      m.default.initialize({ startOnLoad: false, theme: mermaidThemeForCurrentMode() })
    })
  return mermaidReady
}

const getApi = (): MermaidApi | null =>
  ((globalThis as Record<string, unknown>).mermaid as MermaidApi | undefined) ?? null

export const renderMermaidBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll('code.language-mermaid')
  if (blocks.length === 0) return

  await ensureMermaid()
  const api = getApi()
  if (!api) return

  for (const block of blocks) {
    const pre = block.parentElement
    if (!pre) continue
    try {
      const source = block.textContent ?? ''
      const id = `mermaid-${++mermaidRenderCount}`
      const { svg } = await api.render(id, source)
      const wrapper = document.createElement('div')
      wrapper.className = 'my-2 overflow-x-auto'
      wrapper.setAttribute('data-mermaid-source', source)
      wrapper.innerHTML = svg
      pre.replaceWith(wrapper)
    } catch {
      // Leave as code block if mermaid can't parse it
    }
  }
}

export const renderMermaidSource = async (container: HTMLElement, source: string): Promise<void> => {
  await ensureMermaid()
  const api = getApi()
  if (!api) return
  try {
    const id = `mermaid-${++mermaidRenderCount}`
    const { svg } = await api.render(id, source)
    container.innerHTML = svg
    container.setAttribute('data-mermaid-source', source)
  } catch {
    container.textContent = `Mermaid error:\n${source}`
    container.className = 'text-xs text-danger font-mono whitespace-pre'
  }
}

// Re-render all live mermaid diagrams with a new theme. Called on theme flip.
export const reRenderAllMermaid = async (): Promise<void> => {
  const api = getApi()
  if (!api) return
  api.initialize({ startOnLoad: false, theme: mermaidThemeForCurrentMode() })
  const nodes = document.querySelectorAll<HTMLElement>('[data-mermaid-source]')
  for (const node of nodes) {
    const source = node.getAttribute('data-mermaid-source') ?? ''
    if (!source) continue
    try {
      const id = `mermaid-${++mermaidRenderCount}`
      const { svg } = await api.render(id, source)
      node.innerHTML = svg
    } catch {
      // Keep the old render if re-parse fails
    }
  }
}
