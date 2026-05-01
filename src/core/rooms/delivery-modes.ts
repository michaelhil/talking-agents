// ============================================================================
// Delivery Modes — Pure functions for each delivery strategy.
//
// Each mode function receives an `eligible` set (members minus user-muted)
// and delivers accordingly. Room.post() computes eligible once and passes it
// to the active mode. Muting and mode filtering are independent concerns.
//
// Modes:
//   broadcast  — deliver to all eligible members
//   manual     — handled inline in room.post() (humans + sender only)
// ============================================================================

import type { DeliverFn, Message } from '../types/messaging.ts'

// --- Broadcast mode ---

export const deliverBroadcast = (
  message: Message,
  eligible: ReadonlySet<string>,
  deliver: DeliverFn,
): void => {
  for (const id of eligible) {
    deliver(id, message)
  }
}
