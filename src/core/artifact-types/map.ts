// ============================================================================
// Map Artifact Type — Persistent, updateable OpenStreetMap renderings.
//
// Agents create via add_artifact { type: "map", body: { ... } } where body
// is either a custom envelope ({ view?, features:[...] }) or a raw GeoJSON
// FeatureCollection. The renderer sniffs at parse time.
//
// Updates via update_artifact replace the body wholesale (partial-merge is
// overengineering for v1; agents send the full new state). This makes live
// VATSIM feeds simple: the agent calls vatsim_traffic + update_artifact on
// a schedule via per-agent triggers.
//
// formatForContext returns a one-line summary, NOT the full GeoJSON —
// emitting the full body to the agent's context would burn tokens fast on
// a 500-feature flight feed.
// ============================================================================

import type { Artifact, ArtifactTypeDefinition, ArtifactUpdateConfig, ArtifactUpdateResult } from '../types/artifact.ts'

const featureCount = (body: unknown): number => {
  if (!body || typeof body !== 'object') return 0
  const b = body as Record<string, unknown>
  if (Array.isArray(b.features)) return b.features.length
  return 0
}

export const mapArtifactType: ArtifactTypeDefinition = {
  type: 'map',
  description: 'A persistent OpenStreetMap rendering. Body is either a custom envelope ({view?, features:[marker|line|polygon|circle]}) or a GeoJSON FeatureCollection. Update with update_artifact to replace features for live tracking (e.g. VATSIM flight positions).',

  bodySchema: {
    type: 'object',
    description: 'Either { view?, features: [...] } envelope OR a GeoJSON FeatureCollection ({ type: "FeatureCollection", features: [...] }).',
  },

  validateBody: (body: unknown): boolean => {
    if (!body || typeof body !== 'object') return false
    const b = body as Record<string, unknown>
    // GeoJSON shape
    if (b.type === 'FeatureCollection') return Array.isArray(b.features)
    // Envelope shape
    return Array.isArray(b.features)
  },

  onUpdate: (_artifact: Artifact, updates: ArtifactUpdateConfig): ArtifactUpdateResult | void => {
    if (!updates.body || typeof updates.body !== 'object') return
    // Whole-body replace. Keeps the API simple and matches the live-tracking
    // use case (agent re-emits the full feature list each tick).
    return { newBody: updates.body as Record<string, unknown> }
  },

  formatForContext: (artifact: Artifact): string => {
    const n = featureCount(artifact.body)
    return `Map artifact: ${artifact.title} [id: ${artifact.id}, ${n} feature${n === 1 ? '' : 's'}]`
  },

  postSystemMessageOn: ['added', 'removed'],
}
