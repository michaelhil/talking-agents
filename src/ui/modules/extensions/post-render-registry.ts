// Post-render processor registry — replaces the const array previously held
// directly in render-message.ts. Modules register at import time (mermaid,
// map) or at extension mount time (biometrics, future modules). Order is
// determined by registration order, which matches import order in
// render-message.ts (mermaid first, then map) — preserved from the prior
// const-array layout.
//
// All current post-processors target disjoint code-fence selectors
// (`code.language-mermaid`, `code.language-map`, `code.language-geojson`,
// `code.language-biometric`), so order has no behavioural effect today; the
// invariant is documented so future processors that overlap selectors stay
// loud about it.

export type PostRenderProcessor = (container: HTMLElement) => Promise<void>

interface Entry {
  readonly name: string
  readonly fn: PostRenderProcessor
}

const entries: Entry[] = []

export const addPostRenderProcessor = (name: string, fn: PostRenderProcessor): void => {
  // De-dup by name so a hot-reload (or a second import) doesn't re-register.
  // Replace in place to preserve order.
  const idx = entries.findIndex(e => e.name === name)
  if (idx >= 0) entries[idx] = { name, fn }
  else entries.push({ name, fn })
}

export const removePostRenderProcessor = (name: string): void => {
  const idx = entries.findIndex(e => e.name === name)
  if (idx >= 0) entries.splice(idx, 1)
}

export const getPostRenderProcessors = (): ReadonlyArray<PostRenderProcessor> =>
  entries.map(e => e.fn)
