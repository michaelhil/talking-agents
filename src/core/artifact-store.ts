// ============================================================================
// Artifact Store — CRUD store for system-level Artifact instances.
//
// Artifacts live at House level (not room level). Scope field determines
// which rooms can see each artifact; empty scope = system-wide.
//
// Lifecycle: add/update/remove call type hooks via the registry, run
// checkAutoResolve after every mutation, then fire the OnArtifactChanged
// callback exactly once per operation (after all hooks complete).
//
// Store is created in House with a reference to the type registry.
// Type definitions that need store access (e.g. task_list) are factory
// functions that capture a store reference at registration time (no
// circular initialization — store exists before types are registered).
// ============================================================================

import type {
  Artifact,
  ArtifactCreateConfig,
  ArtifactFilter,
  ArtifactStore,
  ArtifactTypeRegistry,
  ArtifactUpdateConfig,
  OnArtifactChanged,
  ToolContext,
} from './types.ts'

export const createArtifactStore = (
  typeRegistry: ArtifactTypeRegistry,
  onChanged?: OnArtifactChanged,
): ArtifactStore => {
  const artifacts = new Map<string, Artifact>()

  const notify = (action: 'added' | 'updated' | 'removed', artifact: Artifact): void => {
    onChanged?.(action, artifact)
  }

  // Run checkAutoResolve; if it returns a resolution string, stamp and re-notify.
  const maybeAutoResolve = (artifact: Artifact): Artifact => {
    if (artifact.resolvedAt) return artifact  // already resolved — never re-resolve
    const typeDef = typeRegistry.get(artifact.type)
    if (!typeDef?.checkAutoResolve) return artifact
    const resolution = typeDef.checkAutoResolve(artifact)
    if (!resolution) return artifact
    const resolved: Artifact = { ...artifact, resolution, resolvedAt: Date.now() }
    artifacts.set(resolved.id, resolved)
    return resolved
  }

  const add = (config: ArtifactCreateConfig): Artifact => {
    const now = Date.now()
    const artifact: Artifact = {
      id: crypto.randomUUID(),
      type: config.type,
      title: config.title,
      body: config.body,
      scope: config.scope ?? [],
      createdBy: config.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    artifacts.set(artifact.id, artifact)

    const typeDef = typeRegistry.get(artifact.type)
    typeDef?.onCreate?.(artifact, { callerId: 'system', callerName: config.createdBy })

    const finalArtifact = maybeAutoResolve(artifact)
    notify('added', finalArtifact)
    return finalArtifact
  }

  const update = (id: string, updates: ArtifactUpdateConfig, ctx?: ToolContext): Artifact | undefined => {
    const existing = artifacts.get(id)
    if (!existing) return undefined

    const typeDef = typeRegistry.get(existing.type)
    const effectiveCtx: ToolContext = ctx ?? { callerId: 'system', callerName: 'system' }

    let newBody = existing.body
    let resolution = updates.resolution

    if (typeDef?.onUpdate) {
      const result = typeDef.onUpdate(existing, updates, effectiveCtx)
      if (result) {
        if (result.newBody !== undefined) newBody = result.newBody
        if (result.resolution !== undefined) resolution = result.resolution
      } else if (updates.body) {
        // No override from type — apply default shallow merge
        newBody = { ...existing.body, ...updates.body }
      }
    } else if (updates.body) {
      newBody = { ...existing.body, ...updates.body }
    }

    const updated: Artifact = {
      ...existing,
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      body: newBody,
      updatedAt: Date.now(),
      ...(resolution !== undefined && !existing.resolvedAt ? { resolution, resolvedAt: Date.now() } : {}),
    }
    artifacts.set(updated.id, updated)

    const finalArtifact = updated.resolvedAt ? updated : maybeAutoResolve(updated)
    notify('updated', finalArtifact)
    return finalArtifact
  }

  const remove = (id: string): boolean => {
    const existing = artifacts.get(id)
    if (!existing) return false
    const typeDef = typeRegistry.get(existing.type)
    typeDef?.onRemove?.(existing)
    artifacts.delete(id)
    notify('removed', existing)
    return true
  }

  const get = (id: string): Artifact | undefined => artifacts.get(id)

  const list = (filter?: ArtifactFilter): ReadonlyArray<Artifact> => {
    let result = [...artifacts.values()]
    if (filter?.type) result = result.filter(a => a.type === filter.type)
    if (filter?.scope) {
      const roomId = filter.scope
      result = result.filter(a => a.scope.length === 0 || a.scope.includes(roomId))
    }
    if (!filter?.includeResolved) result = result.filter(a => !a.resolvedAt)
    return result
  }

  const getForScope = (roomId: string): ReadonlyArray<Artifact> =>
    list({ scope: roomId })

  const restore = (items: ReadonlyArray<Artifact>): void => {
    artifacts.clear()
    for (const artifact of items) artifacts.set(artifact.id, artifact)
  }

  return { add, update, remove, get, list, getForScope, restore }
}
