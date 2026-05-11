// Tool Surface Manager — public API.
//
// One mechanism:
//
//   Family compression (families.ts)
//     Collapse tools sharing a prefix or family rule into a single synthetic
//     dispatcher. 14 filesystem__ tools → 1 fs dispatcher. ~85% token cut on
//     the family.
//
// Provider-aware: when the agent's resolved provider is in
// STRICT_TOOL_SCHEMA_PROVIDERS (currently: gemini), the surface returns the
// FLAT list — family dispatchers use an untyped `args: object` shape that
// strict providers refuse, so we trade compression for accuracy on those.
//
// No hard cap. Earlier versions of this module enforced a 2000-token budget
// cap that silently dropped pack-bundled tools when registration order put
// other tools first — a brittleness landmine that caused production bugs
// (the skill said "call biometrics_start" but the cap had stripped the tool
// from the surface, so models rationalised "not supported in this
// environment"). The cap was removed in favour of trusting user intent:
// pack activation is authoritative. If the user activates a pack, every
// tool that pack registered is in the surface. Period. Surface size
// pressure is a knob the user controls (pack activation toggles), not
// something the system silently mitigates by lying about capabilities.
//
// Stateless except for the registered synthetic dispatcher tools (one-time
// registration at boot). No per-agent state. No snapshot impact.

import type { Tool, ToolDefinition, ToolRegistry } from '../core/types/tool.ts'
import { packNameFor } from '../core/types/tool-pack.ts'
import { toolsToDefinitions } from '../llm/tool-capability.ts'
import { effectiveActivePackSet } from '../packs/activation.ts'
import {
  compressFamilies,
  createFamilyDispatcherTrampoline,
  BUILT_IN_FAMILIES,
  FAMILY_DISPATCHER_NAMES,
  type ToolFamily,
} from './families.ts'
import { isStrictProvider } from './strict-providers.ts'

// Same shape as GetRoomActivation in spawn.ts — duplicated here to avoid an
// import cycle with the agent module while keeping the surface as a leaf.
export interface RoomActivation {
  readonly getActivePacks: () => ReadonlyArray<string>
}
export type GetRoomActivation = (roomId: string) => RoomActivation | undefined

export interface ToolSurface {
  // Project the registered tools down to the LLM-facing definition list,
  // applying family compression (unless provider is strict) and per-room
  // pack activation. Pass the resolved `providerName` if known; pass
  // undefined to conservatively skip compression.
  readonly project: (roomId: string | undefined, providerName: string | undefined) => ReadonlyArray<ToolDefinition>

  // Late-binding dispatcher trampolines for one-time registration into
  // the tool registry. The executor routes by registry lookup; the
  // trampoline re-resolves the family's current members at every call,
  // so packs installed AFTER registration become routable without
  // re-registering. One trampoline per BUILT_IN_FAMILIES entry, regardless
  // of current member count (the trampoline's own minMembers check
  // handles the disabled case).
  readonly getRegistryDispatchers: () => ReadonlyArray<Tool>

  // Test/diagnostic seam: the same candidate-set construction used inside
  // project(). Exposed so the introspection endpoint can report the exact
  // afterActivationCount without re-implementing the rules.
  readonly buildCandidates: (roomId: string | undefined) => ReadonlySet<string>
}

export interface CreateToolSurfaceDeps {
  readonly registry: ToolRegistry
  readonly requestedTools: ReadonlyArray<string>           // existing config.tools ?? all
  readonly getRoomActivation?: GetRoomActivation
  readonly families?: ReadonlyArray<ToolFamily>            // default BUILT_IN_FAMILIES (test seam)
}

export const createToolSurface = (deps: CreateToolSurfaceDeps): ToolSurface => {
  const families = deps.families ?? BUILT_IN_FAMILIES
  const requestedSet = new Set(deps.requestedTools)

  // Compute once per project() call; member resolution is lazy so MCP /
  // pack lifecycle changes are picked up automatically.
  //
  // Two contributions UNION into the candidate set:
  //
  //   1. The agent's requestedTools (config.tools or the implicit-active
  //      default from spawn) — intersected with the registry and then
  //      filtered by per-room pack activation. These are tools the agent
  //      was spawned with.
  //
  //   2. EVERY tool whose owning pack is active in this room. This is the
  //      "pack activation is authoritative" invariant: when a user
  //      activates a pack in a room, ALL of that pack's tools become
  //      visible to any agent in that room, regardless of whether the
  //      agent's requestedTools listed them. Without this, the narrowed
  //      spawn default would silently hide pack-bundled tools the user
  //      explicitly turned on.
  //
  // Family dispatcher names (geo_tools, fs, pack_admin, codegen_tools)
  // are universally excluded from the candidate set — the compressed
  // path re-synthesises them, the flat path wants the underlying tools,
  // and including a stored dispatcher caused Gemini "Duplicate function
  // declaration" failures (geo_tools synthesised + stored sharing a name).
  const buildCandidates = (roomId: string | undefined): ReadonlySet<string> => {
    const room = roomId && deps.getRoomActivation ? deps.getRoomActivation(roomId) : undefined
    const activeSet = room ? effectiveActivePackSet(room) : null

    const accept = (name: string, entry: ReturnType<typeof deps.registry.getEntry>): boolean => {
      if (!entry) return false
      if (FAMILY_DISPATCHER_NAMES.has(name)) return false
      if (!activeSet) return true                                    // no room → no filter
      return activeSet.has(packNameFor(entry))
    }

    const candidates = new Set<string>()
    // (1) agent's requestedTools that pass the activation gate
    for (const name of requestedSet) {
      const entry = deps.registry.getEntry(name)
      if (accept(name, entry)) candidates.add(name)
    }
    // (2) every tool from an active pack — adds pack tools regardless of
    //     whether the agent's spawn-time requestedTools listed them.
    if (activeSet) {
      for (const entry of deps.registry.listEntries()) {
        const name = entry.tool.name
        if (FAMILY_DISPATCHER_NAMES.has(name)) continue
        if (activeSet.has(packNameFor(entry))) candidates.add(name)
      }
    }
    return candidates
  }

  const projectCompressed = (candidates: ReadonlySet<string>): ReadonlyArray<ToolDefinition> => {
    const { dispatchers, passthroughEntries } = compressFamilies(deps.registry, candidates, families)
    const passthroughTools = passthroughEntries.map(e => e.tool)
    return toolsToDefinitions([...dispatchers, ...passthroughTools])
  }

  const projectFlat = (candidates: ReadonlySet<string>): ReadonlyArray<ToolDefinition> => {
    const tools: Tool[] = []
    for (const name of candidates) {
      const t = deps.registry.get(name)
      if (t) tools.push(t)
    }
    return toolsToDefinitions(tools)
  }

  return {
    project: (roomId, providerName) => {
      const candidates = buildCandidates(roomId)
      return isStrictProvider(providerName)
        ? projectFlat(candidates)
        : projectCompressed(candidates)
    },
    getRegistryDispatchers: () => {
      // One trampoline per family in the family table — regardless of
      // current member count. The trampoline's execute() re-resolves
      // members at call time and enforces minMembers itself.
      //
      // Returning all families (not just compressible-now ones) is
      // critical: a pack installed AFTER spawn that bumps a family's
      // membership over minMembers must be routable through the
      // already-registered trampoline. Pre-trampoline, the boot-time
      // snapshot omitted the dispatcher entirely if the family was
      // below threshold, and packs added later were silently unroutable.
      return families.map(f => createFamilyDispatcherTrampoline(f, deps.registry))
    },
    buildCandidates,
  }
}

export { BUILT_IN_FAMILIES, FAMILY_DISPATCHER_NAMES, CORE_TOOL_NAMES } from './families.ts'
export { STRICT_TOOL_SCHEMA_PROVIDERS, isStrictProvider, inferProviderFromModelRef } from './strict-providers.ts'
