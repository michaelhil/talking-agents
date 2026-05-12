// ============================================================================
// Scenario load-time assertions.
//
// Why this exists: scenarios tagged `category: demo` are the showcase set
// that runs end-to-end from a single "Run" click. If a `guide-tooltip` or
// `guide-modal` op slips in with `waitFor: { type: 'click' }`, the demo
// stalls waiting for user input — exactly the "now type this" friction
// the demo category is meant to eliminate.
//
// This file is the structural guard. It runs at scenario-load time (from
// bundled-scenario-loader and from the on-disk pack loader) so a bad demo
// fails at boot, not at run-click. Per the project's anti-pattern note
// against grep-as-policy, this replaces an earlier file-grep proposal.
// ============================================================================

import type { Scenario } from './types.ts'

export const assertDemoIsHandsFree = (scenario: Scenario): void => {
  if (scenario.category !== 'demo') return
  for (const op of scenario.ops) {
    if (op.kind !== 'guide-tooltip' && op.kind !== 'guide-modal') continue
    if (op.waitFor && op.waitFor.type === 'click') {
      throw new Error(
        `Scenario "${scenario.id}" is tagged category: demo but op at line ${op.line} ` +
        `(${op.kind}) uses waitFor: { type: click }. Hands-free demos must auto-advance — ` +
        `use waitFor: { type: timer, seconds: N } or remove the waitFor entirely. ` +
        `If this scenario is actually a tutorial, change frontmatter to category: tutorial.`
      )
    }
  }
}
