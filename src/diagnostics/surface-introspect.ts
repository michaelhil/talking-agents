// Pure read-only introspection of an agent's effective tool surface in a
// given room. Used by GET /api/agents/:name/surface to answer "what does
// this agent actually see when invoked in this room, and why."
//
// No side effects, no caching, no LLM call. Computes the same surface
// the eval would compute, plus per-tool pack attribution and a per-pack
// rollup. Lives in src/diagnostics/ so the tool-surface module stays a
// leaf (no diagnostic-shaped state seeping in).

import type { ToolDefinition } from '../core/types/tool.ts'
import type { System } from '../main.ts'
import { asAIAgent } from '../agents/shared.ts'
import { createToolSurface, inferProviderFromModelRef, type GetRoomActivation } from '../tool-surface/index.ts'
import { packNameFor } from '../core/types/tool-pack.ts'
import { effectiveActivePackSet } from '../packs/activation.ts'
import { estimateTokens } from '../agents/context-builder.ts'
import { CURATED_MODELS } from '../llm/models/catalog.ts'

export interface ToolSurfaceTool {
  readonly name: string
  readonly pack: string                        // owning pack (core/local/<ns>)
  readonly tokens: number                      // estimated definition tokens
}

export interface PackRollup {
  readonly pack: string
  readonly tools: number
  readonly tokens: number
}

export interface AgentSurface {
  readonly agent: string
  readonly agentId: string
  readonly model: string
  // The provider the agent's model is configured under (catalog lookup).
  // This may differ from the provider actually used at eval time after
  // router failover — see activeProvider below.
  readonly configuredProvider: string | null
  // The provider observed on the most recent eval for this agent
  // (from the eval ring buffer), or null if no recent eval recorded.
  // During failover this diverges from configuredProvider; the surface
  // projection rules (compressed vs flat) follow configuredProvider,
  // so a mismatch means recent evals went through a different shape
  // than the diagnostic shows.
  readonly activeProvider: string | null
  readonly roomId: string
  readonly roomName: string
  readonly activePacks: ReadonlyArray<string>
  readonly registeredCount: number
  readonly requestedCount: number
  readonly afterActivationCount: number
  readonly tools: ReadonlyArray<ToolSurfaceTool>
  readonly packs: ReadonlyArray<PackRollup>
  readonly totalTokens: number
}

export const introspectAgentSurface = (
  system: System,
  agentName: string,
  roomId: string,
): AgentSurface | { error: string } => {
  const agent = system.team.getAgent(agentName)
  if (!agent) return { error: `agent "${agentName}" not found` }
  const ai = asAIAgent(agent)
  if (!ai) return { error: `agent "${agentName}" is not an AI agent` }

  const room = system.house.getRoom(roomId)
  if (!room) return { error: `room "${roomId}" not found` }

  const config = ai.getConfig()
  const model = ai.getModel()
  const configuredProvider = inferProviderFromModelRef(model, CURATED_MODELS) ?? null
  const activePacks = effectiveActivePackSet(room)

  const registry = system.toolRegistry
  const requestedTools = config.tools ?? registry.list().map(t => t.name)

  // Reuse the production surface — guarantees we report what the eval
  // would actually compute.
  const getRoomActivation: GetRoomActivation = (id) => system.house.getRoom(id)
  const surface = createToolSurface({ registry, requestedTools, getRoomActivation })
  const defs: ReadonlyArray<ToolDefinition> = surface.project(roomId, configuredProvider ?? undefined)

  const packForName = (name: string): string => {
    const entry = registry.getEntry(name)
    return entry ? packNameFor(entry) : 'unknown'
  }

  const tools: ToolSurfaceTool[] = defs.map(d => ({
    name: d.function.name,
    pack: packForName(d.function.name),
    tokens: estimateTokens(JSON.stringify(d)),
  }))

  const packBuckets = new Map<string, { tools: number; tokens: number }>()
  for (const t of tools) {
    const b = packBuckets.get(t.pack) ?? { tools: 0, tokens: 0 }
    b.tools += 1
    b.tokens += t.tokens
    packBuckets.set(t.pack, b)
  }
  const packs: PackRollup[] = [...packBuckets].map(([pack, b]) => ({ pack, ...b }))
    .sort((a, b) => b.tokens - a.tokens)

  // afterActivation is the candidate set size BEFORE family compression —
  // computed by the surface itself (one source of truth, no parallel
  // re-implementation that can drift).
  const afterActivation = surface.buildCandidates(roomId).size

  // Active provider: pulled from the most recent eval for this agent. If
  // no recent eval is recorded, null. During router failover this
  // diverges from configuredProvider.
  const recent = system.evalBuffer.listRecent({ limit: 1, agent: agent.name })
  const recentModel = recent[0]?.model
  const activeProvider = recentModel
    ? (inferProviderFromModelRef(recentModel, CURATED_MODELS) ?? null)
    : null

  return {
    agent: agent.name,
    agentId: agent.id,
    model,
    configuredProvider,
    activeProvider,
    roomId: room.profile.id,
    roomName: room.profile.name,
    activePacks: [...activePacks].sort(),
    registeredCount: registry.list().length,
    requestedCount: requestedTools.length,
    afterActivationCount: afterActivation,
    tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
    packs,
    totalTokens: tools.reduce((s, t) => s + t.tokens, 0),
  }
}
