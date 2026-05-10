// Biometrics UI extension — declared by samsinn-biometrics pack via
// `ui_extensions: ["biometrics"]`. Mounted by registry.ts when the pack is
// installed; unmounted when it's removed.
//
// mount() lazy-imports the inline-block widget and the settings panel — the
// heavy UI code (canvas overlay, MediaPipe loader hooks) does NOT ship in
// the bundle path until first activation. Users without the pack pay only
// for this small file.
//
// On unmount(): post-render processor is removed, panel deregisters, and a
// page-level `samsinn:biometric-stop-all` event fires so any active capture
// widgets in the DOM tear down cleanly (they own the MediaStream and
// release it via this event handler).

import type { UIExtension, ExtensionAPI } from './registry.ts'

export const createBiometricsExtension = (): UIExtension => {
  let unregisterPanel: (() => void) | null = null

  return {
    name: 'biometrics',
    mount: async (api: ExtensionAPI): Promise<void> => {
      const widget = await import('../modules/biometric/index.ts')
      const panel = await import('../modules/panels/biometric-panel.ts')
      api.addPostRenderProcessor('biometric', widget.renderBiometricBlocks)
      unregisterPanel = api.registerPanel(panel.biometricPanelSpec)
    },
    unmount: async (): Promise<void> => {
      // Tear down any active capture widgets first — they own MediaStreams
      // that must be released before the renderer is removed.
      try {
        document.dispatchEvent(new CustomEvent('samsinn:biometric-stop-all', { detail: { reason: 'extension-unmount' } }))
      } catch { /* SSR/no-DOM safety */ }
      try { unregisterPanel?.() } catch { /* ignore */ }
      unregisterPanel = null
      // Remove the post-render processor so future messages don't try to
      // mount widgets the code path no longer supports.
      const { removePostRenderProcessor } = await import('./post-render-registry.ts')
      removePostRenderProcessor('biometric')
    },
  }
}
