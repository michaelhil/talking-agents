// Bundled demo tools — registered into the shared tool registry at boot
// (see bootstrap.ts). These tools back the showcase demo scenarios; they
// ship in-binary so the demos are fully offline-immune (no GitHub install
// step, no rate-limit failure mode). Watch-me demo's biometrics tools are
// NOT bundled here — they remain in the samsinn-biometrics registry pack
// because their browser-side widget code has its own install lifecycle.
//
// `procedure_lookup` moved out of this pack — it now lives in
// src/packs/pwr-eops/ as its own bundled pack with a real wiki binding
// (samsinn-wikis/pwr-eops). The showcase chip's prompt is unchanged.

import type { Tool } from '../../../core/types/tool.ts'
import { norwayPlatformsTool } from './norway-platforms.ts'
import { vatsimArrivalsTool } from './vatsim-arrivals.ts'

export const BUNDLED_DEMO_TOOLS: ReadonlyArray<Tool> = [
  norwayPlatformsTool,
  vatsimArrivalsTool,
]
