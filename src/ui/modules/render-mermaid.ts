// Mermaid rendering — lazy-loads mermaid.js on first encounter. Replaces
// ```mermaid code blocks with rendered SVG, and renders standalone source
// into a container (for the mermaid artifact type).
//
// Each rendered container stores its source on `data-mermaid-source` so
// re-rendering on theme change can reuse it without re-parsing markdown.
//
// Input normalisation fixes the two most common LLM-generated quirks that
// Mermaid 11 rejects: trailing semicolons and unquoted special characters
// inside node labels. If rendering still fails after normalisation, a
// compact notice replaces the code block — the Mermaid-bomb SVG is
// suppressed via the `suppressErrorRendering` init option so users never
// see it.

let mermaidReady: Promise<MermaidApi> | null = null
let mermaidApi: MermaidApi | null = null
let mermaidRenderCount = 0

type MermaidApi = {
  render: (id: string, source: string) => Promise<{ svg: string }>
  initialize: (config: Record<string, unknown>) => void
}

const mermaidThemeForCurrentMode = (): string =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'neutral'

// Mermaid 11's ESM build does not auto-attach to globalThis.mermaid the way
// older UMD builds did. Resolve the API once and hold it in module scope.
// `suppressErrorRendering: true` makes render() throw on bad syntax instead
// of returning the bomb-icon SVG — we want to show our own fallback UI.
export const ensureMermaid = (): Promise<MermaidApi> => {
  if (mermaidReady) return mermaidReady
  mermaidReady = import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
    .then((m: { default: MermaidApi }) => {
      m.default.initialize({
        startOnLoad: false,
        theme: mermaidThemeForCurrentMode(),
        suppressErrorRendering: true,
      })
      mermaidApi = m.default
      return m.default
    })
  return mermaidReady
}

const getApi = (): MermaidApi | null => mermaidApi

// --- Source normalisation ---
//
// LLMs (especially Gemini-flash class models) reliably produce two kinds of
// mermaid quirks that Mermaid 11 no longer tolerates. Fix both before handing
// source to render().
//
//   1. Trailing `;` on statement lines — once universal, now rejected in
//      strict parses. Safe to strip unconditionally.
//   2. Unquoted special characters inside node labels — `[Divert / Abort]`,
//      `{a>b}`, `(foo#bar)`. The parser treats these as control chars.
//      Wrap the label body in double quotes when the body contains one of
//      `/`, `#`, `<`, `>`, or a leading/trailing whitespace quirk. Leave
//      already-quoted labels alone.

const NEEDS_QUOTING = /[\/#<>]/

const normaliseMermaidSource = (src: string): string => {
  // 1. Strip trailing semicolons from each line.
  const lines = src.split('\n').map(line => line.replace(/;\s*$/, ''))
  let normalised = lines.join('\n')

  // 2. Quote label bodies that contain special chars. Matches label
  //    delimiters [...], (...), {...}. The body must not already contain
  //    the same delimiter or an existing quote.
  normalised = normalised.replace(
    /(\[|\(|\{)([^\[\]\(\)\{\}"\n]+?)(\]|\)|\})/g,
    (match, open: string, body: string, close: string) => {
      const trimmed = body.trim()
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) return match
      if (!NEEDS_QUOTING.test(body)) return match
      return `${open}"${body.trim()}"${close}`
    },
  )

  // 3. LLMs sometimes write bare quoted strings as node references —
  //    `"Process / Store" --> Output` — which Mermaid rejects (a node ref
  //    must be an identifier or `id[label]`). Synthesize a stable ID per
  //    unique label and rewrite both the definition and subsequent refs.
  const labelToId = new Map<string, string>()
  const synthId = (label: string): string => {
    const existing = labelToId.get(label)
    if (existing) return existing
    const id = `n${labelToId.size + 1}`
    labelToId.set(label, id)
    return id
  }
  normalised = normalised.replace(/"([^"\n]+)"/g, (_match, label: string) => {
    // Only convert if this quoted string is NOT already inside brackets —
    // step 2 produced bracketed quotes like `["Foo / Bar"]` which must be
    // left alone. We detect this by looking at the surrounding characters
    // at replace time via a lookahead pattern below.
    return `__MM_LABEL__${synthId(label)}__MM_END__`
  })
  // Restore labels that were inside brackets (i.e. `[__MM_LABEL__n1__MM_END__]`)
  // back to their original quoted form.
  normalised = normalised.replace(
    /(\[|\(|\{)__MM_LABEL__n(\d+)__MM_END__(\]|\)|\})/g,
    (_m, open: string, n: string, close: string) => {
      const label = [...labelToId.entries()].find(([, id]) => id === `n${n}`)?.[0] ?? ''
      return `${open}"${label}"${close}`
    },
  )
  // Any remaining sentinel is a bare-quoted reference — expand to `id["label"]`
  // at first occurrence, then to bare `id` for subsequent references. Track
  // which IDs have been defined already in the same pass.
  const definedIds = new Set<string>()
  normalised = normalised.replace(
    /__MM_LABEL__(n\d+)__MM_END__/g,
    (_m, id: string) => {
      const label = [...labelToId.entries()].find(([, v]) => v === id)?.[0] ?? ''
      if (definedIds.has(id)) return id
      definedIds.add(id)
      return `${id}["${label}"]`
    },
  )

  return normalised
}

// --- Fallback UI ---

const showRenderFallback = (el: HTMLElement, source: string): void => {
  el.className = 'my-2 text-xs border border-border rounded p-2 bg-surface-muted'
  el.innerHTML = `
    <div class="text-text-muted mb-1">Diagram couldn't render — showing source.</div>
    <pre class="whitespace-pre-wrap text-text font-mono text-[11px]"></pre>
  `
  const pre = el.querySelector('pre')
  if (pre) pre.textContent = source
}

export const renderMermaidBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll('code.language-mermaid')
  if (blocks.length === 0) return

  await ensureMermaid()
  const api = getApi()
  if (!api) return

  for (const block of blocks) {
    const pre = block.parentElement
    if (!pre) continue
    const rawSource = block.textContent ?? ''
    const source = normaliseMermaidSource(rawSource)
    const id = `mermaid-${++mermaidRenderCount}`
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-mermaid-source', source)
    try {
      const { svg } = await api.render(id, source)
      wrapper.className = 'my-2 overflow-x-auto'
      wrapper.innerHTML = svg
    } catch {
      showRenderFallback(wrapper, rawSource)
    }
    pre.replaceWith(wrapper)
  }
}

export const renderMermaidSource = async (container: HTMLElement, source: string): Promise<void> => {
  await ensureMermaid()
  const api = getApi()
  if (!api) return
  const normalised = normaliseMermaidSource(source)
  try {
    const id = `mermaid-${++mermaidRenderCount}`
    const { svg } = await api.render(id, normalised)
    container.innerHTML = svg
    container.setAttribute('data-mermaid-source', normalised)
  } catch {
    showRenderFallback(container, source)
    container.setAttribute('data-mermaid-source', normalised)
  }
}

// Re-render all live mermaid diagrams with a new theme. Called on theme flip.
export const reRenderAllMermaid = async (): Promise<void> => {
  const api = getApi()
  if (!api) return
  api.initialize({
    startOnLoad: false,
    theme: mermaidThemeForCurrentMode(),
    suppressErrorRendering: true,
  })
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
