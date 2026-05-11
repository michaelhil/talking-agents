// Biometric session registry — thin specialisation of the generic
// wrapper-registry over CaptureSession. The MediaStream AND the widget's
// view-side timers are owned here, outside the DOM widget, so chat
// re-renders cannot orphan a camera or leave phantom signal-push timers
// ticking against a dead session.
//
// All lifecycle semantics (attach / setWrapper / setViewBinding / release /
// releaseAll / sweepOrphans / onAllReleased) live in the generic module;
// see src/ui/modules/wrapper-registry/index.ts for the invariants.
//
// The only biometric-specific behaviour here is:
//   - disposeResource = (s) => s.stop() (swallow throws — release must complete)
//   - re-export ReleaseReason under this module name so callers that
//     thread `reason` through WS messages don't need to import the
//     generic path

import {
  createWrapperRegistry,
  type ReleaseReason,
  type WrapperRegistry,
} from '../wrapper-registry/index.ts'
import type { CaptureSession } from '../../../biometrics/index.ts'

export type { ReleaseReason }
export type SessionRegistry = WrapperRegistry<CaptureSession>

export interface SessionRegistryConfig {
  // Optional override for tests.
  readonly scheduler?: {
    readonly setInterval: (cb: () => void, ms: number) => unknown
    readonly clearInterval: (handle: unknown) => void
  }
  // Optional onRelease hook used by the widget to send a WS stopped
  // message. Decoupled from the registry so the registry has no WS
  // dependency and stays unit-testable.
  readonly onRelease?: (captureId: string, reason: ReleaseReason) => void
}

export const createSessionRegistry = (config: SessionRegistryConfig = {}): SessionRegistry =>
  createWrapperRegistry<CaptureSession>({
    label: 'biometric',
    disposeResource: async (s) => { try { await s.stop() } catch { /* always swallow — release must complete */ } },
    ...(config.scheduler ? { scheduler: config.scheduler } : {}),
    ...(config.onRelease ? { onRelease: config.onRelease } : {}),
  })
