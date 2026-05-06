// Generic serialise-chain primitive.
//
// Pattern: every call to `run(fn)` awaits the previous one before invoking
// `fn`, then returns fn's resolved value. Behaviour is identical regardless
// of whether the prior call resolved or rejected — failures don't poison
// the chain. Each consumer gets its own chain instance.
//
// Use case: read-modify-write paths against shared state (filesystem,
// in-memory map) where two concurrent calls can interleave. Examples
// already in the codebase before this extraction:
//
//   - src/core/storage/snapshot.ts — saveSnapshot + appendPendingScrub
//   - src/geo/pack-source.ts       — refreshPackGeodata (cross-instance)
//   - src/core/scripts/script-store.ts — upsert / remove / reload
//   - src/tools/built-in/pack-tools.ts — install / update / uninstall
//
// The fourth consumer is what triggered the extraction (see CLAUDE.md
// guidance on threshold for shared abstractions). Earlier consumers
// migrated alongside this introduction so the inline `let chain` /
// serialise pattern lives in exactly one place.

export interface SerialiseChain {
  // Run fn after the previous call settled. Returns fn's resolved value.
  // The chain swallows fn's rejections internally so a single failure
  // doesn't poison subsequent calls — but the caller still sees its own
  // rejection from this run.
  readonly run: <T>(fn: () => Promise<T>) => Promise<T>
  // Test seam — reset the chain to a fresh resolved promise.
  readonly reset: () => void
}

export const createSerialiseChain = (): SerialiseChain => {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    run: <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn, fn)
      // Catch on the chain reference so a rejected fn doesn't break the
      // sequencing for subsequent callers. Caller still sees the original
      // rejection from `next`.
      chain = next.catch(() => undefined)
      return next
    },
    reset: () => { chain = Promise.resolve() },
  }
}
