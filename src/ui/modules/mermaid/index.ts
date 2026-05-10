// Public entrypoints for mermaid rendering.
//
//   renderMermaidBlocks(container) — post-processes ```mermaid code fences
//     inside a rendered markdown container (used by chat message rendering).
//   reRenderAllMermaid() — re-renders every live mermaid node on the page
//     with the current theme (called on theme flip).
//
// Each rendered wrapper stores the normalised source on `data-mermaid-source`
// so theme re-renders can reuse it without re-walking markdown.

import { ensureMermaid, getMermaidApi, reinitMermaid } from './api.ts'
import { normaliseMermaidSource, MAX_MERMAID_SOURCE } from './normalise.ts'
import { showRenderFallback } from './fallback.ts'
import { addPostRenderProcessor } from '../../extensions/post-render-registry.ts'

// Size check, single source of truth for "should we bother rendering?"
const isOversized = (source: string): boolean => source.length > MAX_MERMAID_SOURCE

// Build a rendered-wrapper element from a mermaid SVG string.
const buildRenderedWrapper = (svg: string, normalisedSource: string): HTMLElement => {
  const wrapper = document.createElement('div')
  wrapper.className = 'my-2 overflow-auto max-h-[60vh]'
  wrapper.setAttribute('data-mermaid-source', normalisedSource)
  wrapper.setAttribute('role', 'img')
  // First line of source is usually the diagram type (`flowchart LR`) —
  // a concise hint for screen readers.
  const firstLine = normalisedSource.split('\n', 1)[0]?.trim() ?? 'Diagram'
  wrapper.setAttribute('aria-label', `Diagram: ${firstLine.slice(0, 60)}`)
  wrapper.innerHTML = svg
  return wrapper
}

export const renderMermaidBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll('code.language-mermaid')
  if (blocks.length === 0) return

  const api = await ensureMermaid()

  let localIdCounter = 0
  for (const block of blocks) {
    const pre = block.parentElement
    if (!pre) continue
    const rawSource = block.textContent ?? ''

    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-mermaid-source', rawSource)

    if (!api) {
      showRenderFallback(wrapper, rawSource, 'unavailable')
      pre.replaceWith(wrapper)
      continue
    }

    if (isOversized(rawSource)) {
      showRenderFallback(wrapper, rawSource, 'too-large')
      pre.replaceWith(wrapper)
      continue
    }

    const source = normaliseMermaidSource(rawSource)
    const id = `mermaid-${Date.now()}-${++localIdCounter}`
    try {
      const { svg } = await api.render(id, source)
      pre.replaceWith(buildRenderedWrapper(svg, source))
    } catch {
      showRenderFallback(wrapper, rawSource, 'render-failed')
      pre.replaceWith(wrapper)
    }
  }
}

// Self-register at module-load time. Order = first-registered wins; mermaid
// is imported before map in render-message.ts so it lands first in the
// registry, preserving the prior const-array order.
addPostRenderProcessor('mermaid', renderMermaidBlocks)

// Re-render every live mermaid diagram with the current theme. Runs in
// parallel — serial rendering was noticeable flicker for pages with many
// diagrams.
export const reRenderAllMermaid = async (): Promise<void> => {
  const api = getMermaidApi()
  if (!api) return
  reinitMermaid()

  const nodes = [...document.querySelectorAll<HTMLElement>('[data-mermaid-source]')]
  let localIdCounter = 0
  await Promise.all(nodes.map(async (node) => {
    const source = node.getAttribute('data-mermaid-source') ?? ''
    if (!source) return
    try {
      const id = `mermaid-retheme-${Date.now()}-${++localIdCounter}`
      const { svg } = await api.render(id, source)
      node.innerHTML = svg
    } catch {
      // Keep the old render if re-parse fails.
    }
  }))
}
