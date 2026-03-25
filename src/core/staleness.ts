// ============================================================================
// Staleness — Find the participating agent who hasn't spoken the longest.
//
// Scans a message array from the end to find each participating agent's last
// message position. The agent with the oldest (or absent) last message is the
// "stalest" and should speak next in turn-taking mode.
//
// Pure function — no side effects, depends only on Message type.
// ============================================================================

import type { Message } from './types.ts'

export const findStalestAgent = (
  messages: ReadonlyArray<Message>,
  participating: ReadonlySet<string>,
  exclude?: string,
): string | undefined => {
  if (participating.size === 0) return undefined

  const candidates = exclude
    ? new Set([...participating].filter(id => id !== exclude))
    : new Set(participating)

  if (candidates.size === 0) return undefined

  const lastSeen = new Map<string, number>()

  for (let i = messages.length - 1; i >= 0; i--) {
    const senderId = messages[i]!.senderId
    if (candidates.has(senderId) && !lastSeen.has(senderId)) {
      lastSeen.set(senderId, i)
    }
    if (lastSeen.size === candidates.size) break
  }

  let stalest: string | undefined
  let stalestIndex = Infinity

  for (const id of candidates) {
    const index = lastSeen.get(id) ?? -1  // never spoken = maximally stale
    if (index < stalestIndex) {
      stalestIndex = index
      stalest = id
    }
  }

  return stalest
}
