// ============================================================================
// Shared resolver utilities for HTTP and WebSocket handlers.
//
// resolveRoom: looks up a room by ID or name via House.getRoom (handles both).
// resolveAgent: looks up an agent by ID or name via Team.getAgent (handles both).
// ============================================================================

import type { House, Team, Room, Agent } from '../core/types.ts'

// Resolves a room by ID or name — House.getRoom handles both via its name index.
export const resolveRoom = (nameOrId: string, house: House): Room | undefined =>
  house.getRoom(nameOrId)

// Resolves an agent by ID or name — Team.getAgent handles both via its name index.
export const resolveAgent = (nameOrId: string, team: Team): Agent | undefined =>
  team.getAgent(nameOrId)
