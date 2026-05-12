// ============================================================================
// Synthetic 'demos' pack — bundled with the binary, hosts the capability-
// showcase scenarios users find via Settings → Scenarios or the empty-state
// strip.
//
// Like 'welcome', this pack ships in the binary (no install, always
// implicitly active). Welcome stays separate as the first-boot seed; demos
// here are user-discoverable capability tours.
//
// Phase 1 ships 3 demos:
//   - first-conversation: guided tour of basic UI affordances
//   - diagram-thinking: agent draws a mermaid flowchart inline
//   - biometric-awareness: agent observes via webcam (installs the
//     samsinn-biometrics pack — needs explicit consent in the dialog)
//
// Phase 2+ adds: two-agent-debate, aviation-live, research-workspace,
// triggers-and-summary (each blocked on additional ops or pack installs).
// ============================================================================

import type { System } from '../../main.ts'
import type { ExtraSource } from '../../core/scenarios/store.ts'
import { buildBundledExtraSource } from '../bundled-scenario-loader.ts'

export const DEMOS_PACK_NAMESPACE = 'demos'

// Demo scenarios reference `__DEFAULT_MODEL__` literally in their .md
// sources. Resolution is deferred to run-time (see DEFAULT_MODEL_PLACEHOLDER
// in src/core/scenarios/types.ts) — at run-start the model resolves to the
// user's pick from the run dialog, or the system's current curated default.
// This used to be load-time substitution via pickDemoModel(); that approach
// froze a value at boot and persisted bad resolutions until restart.
export const buildDemosExtraSource = (_system: System): ExtraSource =>
  buildBundledExtraSource({
    pack: DEMOS_PACK_NAMESPACE,
    scenarios: [
      // Showcase demos (category: demo) — one-click, hands-free.
      {
        name: 'norway-platforms',
        file: './norway-platforms.scenario.md',
        importMetaUrl: import.meta.url,
      },
      {
        name: 'vatsim-heathrow',
        file: './vatsim-heathrow.scenario.md',
        importMetaUrl: import.meta.url,
      },
      {
        name: 'diagram',
        file: './diagram.scenario.md',
        importMetaUrl: import.meta.url,
      },
      {
        name: 'pwr-eop',
        file: './pwr-eop.scenario.md',
        importMetaUrl: import.meta.url,
      },
      {
        name: 'biometric-awareness',
        file: './biometric-awareness.scenario.md',
        importMetaUrl: import.meta.url,
      },
      // Tutorials (category: tutorial) — guided, user-driven.
      {
        name: 'first-conversation',
        file: './first-conversation.scenario.md',
        importMetaUrl: import.meta.url,
      },
      {
        name: 'diagram-thinking',
        file: './diagram-thinking.scenario.md',
        importMetaUrl: import.meta.url,
      },
    ],
    // No tokens — `__DEFAULT_MODEL__` is left as-is in the .md and
    // resolved at run-time by ops.ts:resolveModel.
  })
