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
import { CURATED_MODELS } from '../../llm/models/catalog.ts'
import { resolveDefaultModel, type ProviderSnapshot } from '../../llm/models/default-resolver.ts'
import { buildBundledExtraSource } from '../bundled-scenario-loader.ts'

export const DEMOS_PACK_NAMESPACE = 'demos'

// Demo scenarios use the same `__DEFAULT_MODEL__` token welcome uses so
// re-resolution per System works the same way. The demos pack picks the
// same model with the same logic — extracting the resolver to a shared
// helper would be premature (one extra consumer = three).
const pickDemoModel = (system: System): string => {
  const override = process.env.SAMSINN_SEED_MODEL
  if (override && override.trim()) return override.trim()
  const names = new Set<string>([...Object.keys(CURATED_MODELS), 'ollama'])
  const providers: ProviderSnapshot[] = [...names].map(name => {
    const enabled = name === 'ollama' ? !!system.ollama : system.providerKeys.isEnabled(name)
    return {
      name,
      status: enabled ? 'ok' : 'no_key',
      models: (CURATED_MODELS[name] ?? []).map(m => ({ id: m.id })),
    }
  })
  return resolveDefaultModel(providers) || 'gemini-2.5-pro'
}

export const buildDemosExtraSource = (system: System): ExtraSource =>
  buildBundledExtraSource({
    pack: DEMOS_PACK_NAMESPACE,
    scenarios: [
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
      {
        name: 'biometric-awareness',
        file: './biometric-awareness.scenario.md',
        importMetaUrl: import.meta.url,
      },
    ],
    tokens: {
      '__DEFAULT_MODEL__': pickDemoModel(system),
    },
  })
