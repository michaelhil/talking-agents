// Pack activation resolver — single source of truth for "which packs are
// active in room X."
//
// Two implicit-active packs are always present and not stored:
//   - 'core'  — built-in tools, immutable, never deactivated
//   - 'local' — user's drop-in tools/skills/scripts/geodata, default-active
//
// Anything else is opt-in per room via room.setActivePacks([...]).
//
// This is a pure function over (room, installed packs). It is NOT cached —
// the compute is trivial (set membership over <50 strings) and any cache
// would just be a b660b3e-pattern landmine waiting to drift out of sync
// with install/uninstall/activation events.

const IMPLICIT_ACTIVE: ReadonlyArray<string> = ['core', 'local']

export interface RoomActivation {
  readonly getActivePacks: () => ReadonlyArray<string>
}

// Effective active packs for a room — the implicit pair followed by whatever
// the user has activated.
//
// NOTE: this list is an ALLOWLIST for tool/skill/script visibility per room.
// It does NOT govern resolution order for collisions. Pack-bundled geodata
// category metadata (see src/geo/pack-source.ts:reload) is built once at
// boot across ALL installed packs in filesystem-scan order — first-feature-
// wins per category id, regardless of which packs are active in a given
// room. Pack authors must namespace their category ids to avoid collisions.
export const effectiveActivePacks = (room: RoomActivation): ReadonlyArray<string> => {
  const explicit = room.getActivePacks()
  if (explicit.length === 0) return IMPLICIT_ACTIVE
  return [...IMPLICIT_ACTIVE, ...explicit]
}

// Set membership form for hot-path filters (e.g. tool surface filter on
// every agent spawn). Walking <20 strings is trivial; the Set form just
// reads slightly cleaner at call sites.
export const effectiveActivePackSet = (room: RoomActivation): ReadonlySet<string> =>
  new Set(effectiveActivePacks(room))

// True if a pack identified by `packNamespace` (or undefined for tools that
// don't carry pack metadata, like built-ins) is active in the room.
//
// Tools without a pack (kind: 'built-in', 'external', 'skill-bundled' that
// pre-dates pack-bundling) are treated as core/local respectively at the
// caller — this helper is pack-namespace-aware only.
export const isPackActiveInRoom = (
  room: RoomActivation,
  packNamespace: string,
): boolean => effectiveActivePackSet(room).has(packNamespace)
