// Pure state machine for "indicator stays visible at least N ms once shown".
//
// The renderer subscribes to a stream of "currently visible" sets from
// $visibleThinkingIndicators. When an id leaves the set we don't remove it
// immediately — we hold for MIN_VISIBLE_MS minus the elapsed time since
// creation. If the id re-enters the set during the hold, the pending removal
// is cancelled. This is what kills the flash-and-vanish on fast generations.
//
// Pure: inputs are (current visible ids, internal map of created/pending
// timers, now); outputs are { toCreate, toRemoveImmediately, toScheduleRemove }.
// All side effects (createTimeout / clearTimeout / DOM writes) live in the
// renderer; this module just decides what should happen.

export interface MinVisibleEntry {
  readonly createdAt: number
  readonly pendingRemovalHandle?: unknown   // opaque to this module
}

export interface MinVisibleDecision {
  readonly toCreate: ReadonlyArray<string>
  // ids whose hold has already elapsed — remove now.
  readonly toRemoveImmediately: ReadonlyArray<string>
  // ids that should be scheduled for removal — caller stores the handle.
  readonly toScheduleRemove: ReadonlyArray<{ id: string; delayMs: number }>
  // ids that came back into the visible set — caller cancels their pending
  // removal handle and clears it from the entry.
  readonly toCancelRemoval: ReadonlyArray<string>
}

export const computeMinVisibleDecision = (
  current: Map<string, MinVisibleEntry>,
  visibleIds: ReadonlySet<string>,
  now: number,
  minVisibleMs: number,
): MinVisibleDecision => {
  const toCreate: string[] = []
  const toRemoveImmediately: string[] = []
  const toScheduleRemove: { id: string; delayMs: number }[] = []
  const toCancelRemoval: string[] = []

  // Check existing entries: still visible? still has pending removal?
  for (const [id, entry] of current) {
    if (visibleIds.has(id)) {
      // Came back into the visible set during a hold — cancel the removal.
      if (entry.pendingRemovalHandle !== undefined) toCancelRemoval.push(id)
    } else if (entry.pendingRemovalHandle === undefined) {
      // Just left the visible set — decide hold duration.
      const elapsed = now - entry.createdAt
      const remaining = minVisibleMs - elapsed
      if (remaining <= 0) toRemoveImmediately.push(id)
      else toScheduleRemove.push({ id, delayMs: remaining })
    }
    // else: not visible, already pending removal — leave it alone.
  }

  // New ids in the visible set with no entry yet.
  for (const id of visibleIds) {
    if (!current.has(id)) toCreate.push(id)
  }

  return { toCreate, toRemoveImmediately, toScheduleRemove, toCancelRemoval }
}
