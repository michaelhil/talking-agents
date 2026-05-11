// Family compression — Layer 1 of the Tool Surface Manager.
//
// Concept: a *family* groups related tools (e.g. all `filesystem__*` MCP
// tools, all `geo_*` built-ins) under a single synthetic dispatcher tool
// shown to the LLM. The dispatcher takes a `subcommand` parameter + free-
// form `args`; its execute() routes to the underlying tool. Underlying
// tools stay registered and callable by their real names — only the
// LLM-facing surface changes.
//
// Why this works: tool descriptions are the bulk of the token bill, and 14
// filesystem tools at ~150 tokens each (= ~2100 tokens of schemas) collapse
// into one dispatcher of ~280 tokens. ~87% reduction on that family.
//
// Member resolution is LAZY — `resolveMembers()` runs at every projection,
// so a disconnected MCP server's tools just drop from the dispatcher's
// enum on the next call. Zero members → dispatcher is omitted entirely
// (we don't ship an empty enum to the LLM).
//
// Subcommand schema strategy:
//   - ≤ 10 members: structural `enum`, LLM picks from a fixed list
//   - >  10 members: free-form `string`, list documented in description only
// (The enum becomes too token-heavy itself above ~10 members; switching to
// a string with description-doc-driven enumeration trades validation for
// scaling.)

import type { Tool, ToolContext, ToolResult, ToolRegistry, ToolRegistryEntry } from '../core/types/tool.ts'

export interface ToolFamily {
  readonly name: string                                          // dispatcher tool name (also reserved at boot)
  readonly description: string                                   // 1-line family purpose
  readonly match: (entry: ToolRegistryEntry) => boolean
  readonly subcommandName: (entry: ToolRegistryEntry) => string  // strip prefix etc.
  readonly minMembers: number                                    // compress only when ≥ this many actually exist
}

// Threshold at which the dispatcher's `subcommand` parameter flips from
// structural enum (precise but token-heavy) to free-form string (looser but
// scales). Tuned for the OpenAI cost-per-enum-value vs description prose.
export const ENUM_MAX_MEMBERS = 10

export const BUILT_IN_FAMILIES: ReadonlyArray<ToolFamily> = [
  {
    name: 'fs',
    description: 'Read, write, list, search, and inspect files in allowed directories. One subcommand per file operation.',
    match: e => e.tool.name.startsWith('filesystem__'),
    subcommandName: e => e.tool.name.slice('filesystem__'.length),
    minMembers: 3,
  },
  {
    name: 'geo_tools',
    description: 'Look up, list, add, and remove places (cities, airports, offshore platforms). Geodata is sourced from active packs.',
    match: e => /^geo_(lookup|add|remove|list_categories|list_features)$/.test(e.tool.name),
    subcommandName: e => e.tool.name.slice('geo_'.length),
    minMembers: 3,
  },
  {
    name: 'pack_admin',
    description: 'Install, update, uninstall, and list packs from GitHub. Use list_available first to discover canonical names.',
    match: e => /^(install_pack|update_pack|uninstall_pack|list_packs|list_available_packs)$/.test(e.tool.name),
    subcommandName: e => e.tool.name,                            // names are already short; keep as-is
    minMembers: 3,
  },
  {
    name: 'codegen_tools',
    description: 'Author new skills + tools at runtime. write_skill creates a Markdown skill; write_tool authors a TypeScript tool; test_tool runs an arbitrary tool one-off.',
    match: e => /^(write_skill|write_tool|test_tool)$/.test(e.tool.name),
    subcommandName: e => e.tool.name,
    minMembers: 2,
  },
]

// Reserved dispatcher names — derived from BUILT_IN_FAMILIES so the two
// can never drift. Used by the projection candidate filter to exclude
// any previously-registered dispatcher (the projection re-synthesises
// dispatchers fresh; including the stored copy caused Gemini "Duplicate
// function declaration" failures).
export const FAMILY_DISPATCHER_NAMES: ReadonlySet<string> =
  new Set(BUILT_IN_FAMILIES.map(f => f.name))

// Single source of truth for which tools are always retained regardless of
// any pruning/budget logic. Layer 4 (budget cap) imports this; future
// layers can read from the same set.
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'pass',
  'post_to_room',
  'get_my_context',
  'get_time',
])

interface ResolvedMembers {
  readonly family: ToolFamily
  readonly members: ReadonlyArray<ToolRegistryEntry>
}

export const resolveFamilyMembers = (
  registry: ToolRegistry,
  families: ReadonlyArray<ToolFamily>,
  candidateNames: ReadonlySet<string>,
): ReadonlyArray<ResolvedMembers> => {
  const all = registry.listEntries()
  return families.map(family => {
    const members = all.filter(e => family.match(e) && candidateNames.has(e.tool.name))
    return { family, members }
  })
}

// Build a dispatcher's description with compact subcommand summaries. Each
// member contributes one line; we extract the parameter keys from its
// schema to give the LLM a structural hint without the full schema.
const buildDispatcherDescription = (
  family: ToolFamily,
  members: ReadonlyArray<ToolRegistryEntry>,
): string => {
  const lines: string[] = [family.description, '', 'Subcommands:']
  for (const m of members) {
    const sub = family.subcommandName(m)
    const paramHint = extractParamHint(m.tool.parameters)
    // Slice the underlying description to keep the dispatcher itself bounded.
    // The original description is preserved on the underlying tool; the LLM
    // can call tool_help (when shipped) for the full text.
    const shortDesc = (m.tool.description ?? '').replace(/\s+/g, ' ').slice(0, 100)
    lines.push(`  ${sub}(${paramHint}) — ${shortDesc}`)
  }
  return lines.join('\n')
}

const extractParamHint = (params: Record<string, unknown>): string => {
  const props = (params as { properties?: Record<string, unknown> }).properties
  if (!props || typeof props !== 'object') return ''
  const required = new Set((params as { required?: ReadonlyArray<string> }).required ?? [])
  return Object.keys(props)
    .map(k => required.has(k) ? k : `${k}?`)
    .join(', ')
}

// Synthesise a dispatcher tool from a family + its members. The dispatcher
// is a regular Tool; the registry stores it as built-in. execute() routes
// to the underlying tool's execute() by looking up the resolved member.
//
// Note: dispatcher.execute receives `params = { subcommand, args }`. It
// pulls args out and forwards to the member's execute. ToolContext flows
// through unchanged so callerId/llm/etc. work the same.
export const createFamilyDispatcher = (
  family: ToolFamily,
  members: ReadonlyArray<ToolRegistryEntry>,
): Tool => {
  if (members.length === 0) {
    throw new Error(`createFamilyDispatcher: empty members for ${family.name}`)
  }
  const memberMap = new Map<string, ToolRegistryEntry>()
  for (const m of members) memberMap.set(family.subcommandName(m), m)
  const subcommandNames = [...memberMap.keys()]

  const subcommandSchema: Record<string, unknown> = members.length <= ENUM_MAX_MEMBERS
    ? { type: 'string', enum: subcommandNames }
    : { type: 'string', description: `One of: ${subcommandNames.join(', ')}` }

  return {
    name: family.name,
    description: buildDispatcherDescription(family, members),
    parameters: {
      type: 'object',
      properties: {
        subcommand: subcommandSchema,
        args: {
          type: 'object',
          description: 'Arguments object for the chosen subcommand. Shape depends on the subcommand — see the description for each subcommand\'s parameters.',
          additionalProperties: true,
        },
      },
      required: ['subcommand', 'args'],
    },
    execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
      const sub = typeof params.subcommand === 'string' ? params.subcommand : ''
      if (!sub) {
        return { success: false, error: `${family.name}: missing required \`subcommand\` parameter` }
      }
      const target = memberMap.get(sub)
      if (!target) {
        return {
          success: false,
          error: `${family.name}: unknown subcommand "${sub}". Valid: ${subcommandNames.join(', ')}`,
        }
      }
      const args = (params.args && typeof params.args === 'object')
        ? (params.args as Record<string, unknown>)
        : {}
      try {
        return await target.tool.execute(args, context)
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

// Late-binding dispatcher: registered ONCE into the global registry at
// agent spawn time, this Tool's execute() re-resolves the family's
// members from the registry on every call. The previous shape
// (createFamilyDispatcher) captured a memberMap snapshot at registration
// time — combined with the `if (!registry.has(name)) register` guard in
// spawn.ts, that meant a pack installed AFTER the dispatcher was first
// registered would never become routable: the LLM-facing projection
// (re-synthesised per-eval) advertised the new subcommand, but the
// executor's registry.get(name) returned the stale closure.
//
// This trampoline closes the gap: members are resolved at execute time
// against current registry state. Cost: one filter pass per dispatcher
// call (registry.listEntries() is in-memory, N is small). Snapshot:
// none — dispatcher is built-in, doesn't persist.
//
// minMembers is enforced at execute time too: if a pack uninstall has
// dropped membership below threshold, the projection hides the
// dispatcher, but a model that cached the name from a prior turn could
// still call it. Return a coherent "family disabled" error instead of
// routing into a degenerate state.
export const createFamilyDispatcherTrampoline = (
  family: ToolFamily,
  registry: ToolRegistry,
): Tool => {
  return {
    name: family.name,
    // Description here is static — the LLM never sees this one; it sees
    // the per-projection dispatcher built by createFamilyDispatcher from
    // current members. This description is only visible if some tool
    // happens to introspect the registry for help text.
    description: `${family.description} (trampoline — late-binds to current registry members)`,
    parameters: {
      type: 'object',
      properties: {
        subcommand: { type: 'string' },
        args: { type: 'object', additionalProperties: true },
      },
      required: ['subcommand', 'args'],
    },
    execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
      const sub = typeof params.subcommand === 'string' ? params.subcommand : ''
      if (!sub) {
        return { success: false, error: `${family.name}: missing required \`subcommand\` parameter` }
      }
      const members = registry.listEntries().filter(e => family.match(e))
      if (members.length < family.minMembers) {
        return {
          success: false,
          error: `${family.name}: family disabled — only ${members.length} of ${family.minMembers} required members registered`,
        }
      }
      const memberMap = new Map<string, ToolRegistryEntry>()
      for (const m of members) memberMap.set(family.subcommandName(m), m)
      const target = memberMap.get(sub)
      if (!target) {
        const valid = [...memberMap.keys()].join(', ')
        return { success: false, error: `${family.name}: unknown subcommand "${sub}". Valid: ${valid}` }
      }
      const args = (params.args && typeof params.args === 'object')
        ? (params.args as Record<string, unknown>)
        : {}
      try {
        return await target.tool.execute(args, context)
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

// Compute "if we compressed this candidate tool set with these families,
// which tools are members of which dispatcher (and therefore replaced),
// which families have enough members to actually compress, and which
// remain as passthrough tools shown to the LLM at their real names"?
//
// Pure function over the registry's current snapshot — no side effects.
// Re-runs every projection call.
export interface CompressionResult {
  readonly dispatchers: ReadonlyArray<Tool>                           // synthetic dispatcher tools (one per family that fired)
  readonly absorbedNames: ReadonlySet<string>                         // underlying tools subsumed by a dispatcher (hidden from LLM)
  readonly passthroughEntries: ReadonlyArray<ToolRegistryEntry>       // remaining tools shown at their real names
}

export const compressFamilies = (
  registry: ToolRegistry,
  candidateNames: ReadonlySet<string>,
  families: ReadonlyArray<ToolFamily> = BUILT_IN_FAMILIES,
): CompressionResult => {
  const allCandidates = registry.listEntries().filter(e => candidateNames.has(e.tool.name))
  const dispatchers: Tool[] = []
  const absorbed = new Set<string>()

  for (const family of families) {
    const members = allCandidates.filter(e => family.match(e))
    if (members.length < family.minMembers) continue
    dispatchers.push(createFamilyDispatcher(family, members))
    for (const m of members) absorbed.add(m.tool.name)
  }

  const passthroughEntries = allCandidates.filter(e => !absorbed.has(e.tool.name))
  return { dispatchers, absorbedNames: absorbed, passthroughEntries }
}
