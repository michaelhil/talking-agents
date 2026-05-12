// ============================================================================
// Synthetic 'welcome' pack — bundled with the binary, hosts the default
// first-run scenario that replaces the old hardcoded seed-example.ts.
//
// Scenarios live in this directory as .md files (readable + diffable). The
// bundled-scenario-loader helper reads them at extraSources() time and
// returns the ExtraSource the scenario store consumes.
//
// The pack is "synthetic" in the same sense as 'core' and 'local' — it
// doesn't appear under SAMSINN_HOME/packs and isn't installable.
//
// Model handling: scenarios use `__DEFAULT_MODEL__` as a runtime placeholder
// (see DEFAULT_MODEL_PLACEHOLDER in core/scenarios/types.ts), resolved at
// spawn-agent-op time against live provider state. The old load-time
// `__WELCOME_DEFAULT_MODEL__` substitution was removed because it froze
// the value at boot — a bad resolution at that moment (provider transiently
// down, env not loaded, stale catalog before --watch reload) persisted
// for the lifetime of the server.
// ============================================================================

import type { System } from '../../main.ts'
import type { ExtraSource } from '../../core/scenarios/store.ts'
import { buildBundledExtraSource } from '../bundled-scenario-loader.ts'

export const WELCOME_PACK_NAMESPACE = 'welcome'
export const WELCOME_DEFAULT_SCENARIO = 'getting-started'
export const WELCOME_DEFAULT_SCENARIO_ID = `${WELCOME_PACK_NAMESPACE}/${WELCOME_DEFAULT_SCENARIO}`

export const buildWelcomeExtraSource = (_system: System): ExtraSource =>
  buildBundledExtraSource({
    pack: WELCOME_PACK_NAMESPACE,
    scenarios: [
      {
        name: WELCOME_DEFAULT_SCENARIO,
        file: './getting-started.scenario.md',
        importMetaUrl: import.meta.url,
      },
    ],
    // No tokens — `__DEFAULT_MODEL__` is left as-is in the .md and
    // resolved at run-time by ops.ts:resolveModel.
  })
