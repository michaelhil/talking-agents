// Public entrypoint for biometric inline-block rendering. Mirrors the shape
// of mermaid/index.ts and map/index.ts: a single renderXBlocks(container)
// post-processor.
//
// Note: unlike mermaid/map, biometrics does NOT self-register at module-load
// time. Registration happens in src/ui/modules/extensions/biometrics.ts inside
// mount(), so the post-processor is only active while the
// samsinn-biometrics pack is installed. This keeps the pack-gating
// invariant: an uninstalled pack means the renderer never fires, even if
// some old chat history still contains a `\`\`\`biometric` block.

export { renderBiometricBlocks } from './widget.ts'
