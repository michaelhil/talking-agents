// Bundled demo tools — registered into the shared tool registry at boot
// (see bootstrap.ts). These tools back the Aviation Demo; they ship
// in-binary so the demos are fully offline-immune (no GitHub install
// step, no rate-limit failure mode).
//
// Biometrics tools (used by the Biometrics Demo) are NOT bundled here —
// they remain in the samsinn-biometrics registry pack because their
// browser-side widget code has its own install lifecycle; the demo modal
// triggers a pack-install on first launch.

import type { Tool } from '../../../core/types/tool.ts'
import { norwayPlatformsTool } from './norway-platforms.ts'
import { vatsimArrivalsTool } from './vatsim-arrivals.ts'

export const BUNDLED_DEMO_TOOLS: ReadonlyArray<Tool> = [
  norwayPlatformsTool,
  vatsimArrivalsTool,
]
