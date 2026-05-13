// ============================================================================
// seedInstance — first-boot seed for a fresh instance.
//
// Creates room "Cafe" (broadcast mode) with one AI ("Aiden") and one Human
// ("You"). Replaces the prior welcome-scenario seed path. Plain TS — no
// scenario engine, no markdown parser, no ops.
//
// The AI's model is the current curated default (via resolveDefaultModel
// against live provider state). If nothing qualifies — fresh boot before any
// provider key is set — we still spawn the agent with 'gpt-5.4' as the
// preferred model; the per-call effective-model resolver in agent eval will
// swap it out for whatever's available once the user adds a key. This keeps
// the snapshot stable across "no key → key added" transitions.
// ============================================================================

import type { System } from '../../main.ts'
import { resolveDefaultModel, type ProviderSnapshot } from '../../llm/models/default-resolver.ts'
import { CURATED_MODELS } from '../../llm/models/catalog.ts'

const FALLBACK_MODEL = 'gpt-5.4'

// Build a minimal ProviderSnapshot[] from live System state. Mirrors the
// subset of /api/routes/house.ts:/api/models that resolveDefaultModel needs.
// No /api/models HTTP call — that would self-trigger before the server has
// bound a port.
const buildProviderSnapshots = (system: System): ReadonlyArray<ProviderSnapshot> => {
  const out: ProviderSnapshot[] = []
  const monitor = system.llm.getMonitorSnapshot()
  for (const name of system.providerConfig.order) {
    if (name === 'ollama') {
      const gw = system.ollama
      const m = monitor.ollama
      const cool = m && m.sub === 'backoff'
      const available = gw?.getHealth().availableModels ?? []
      out.push({
        name: 'ollama',
        status: cool ? 'cooldown' : (available.length === 0 ? 'down' : 'ok'),
        models: available.map(id => ({ id })),
      })
      continue
    }
    const enabled = system.providerKeys.isEnabled(name)
    const m = monitor[name]
    const status: ProviderSnapshot['status'] =
      !enabled ? 'no_key' :
      m && (m.sub === 'no_key' || m.sub === 'disabled') ? 'no_key' :
      m && (m.sub === 'down' || m.sub === 'unhealthy') ? 'down' :
      m && m.sub === 'backoff' ? 'cooldown' :
      'ok'
    // Curated picks first, then reported. resolveDefaultModel takes the head.
    const curated = (CURATED_MODELS[name] ?? []).map(c => ({ id: c.id }))
    const reported = (system.gateways[name]?.getHealth().availableModels ?? []).map(id => ({ id }))
    const seen = new Set<string>()
    const models: Array<{ id: string }> = []
    for (const m of [...curated, ...reported]) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      models.push(m)
    }
    out.push({ name, status, models })
  }
  return out
}

export const seedInstance = async (system: System): Promise<void> => {
  // Idempotency: if a Cafe already exists (e.g. re-seed call), bail.
  const existing = system.house.listAllRooms().some(p => p.name === 'Cafe')
  if (existing) return

  const model = resolveDefaultModel(buildProviderSnapshots(system)) || FALLBACK_MODEL

  // Room first so spawned agents have something to join.
  const room = system.house.createRoom({ name: 'Cafe', createdBy: 'system' })

  // AI: Aiden — a friendly default companion. No tool whitelist → sees every
  // tool active in the room (pack-aware filter at the call site).
  const aiden = await system.spawnAIAgent({
    name: 'Aiden',
    model,
    preferredModel: model,
    persona: 'You are Aiden, a friendly and curious assistant. You help the user explore what this system can do — answer questions directly, call tools when useful, and keep replies concise.',
  })
  await system.addAgentToRoom(aiden.id, room.profile.id, 'seed')

  // Human: "You" — the seat the connecting user will adopt on first connect.
  // The transport `send` is a no-op until a real WS attaches via the
  // adoptHuman path; spawnHumanAgent installs it lazily.
  const you = await system.spawnHumanAgent({ name: 'You' }, () => { /* no transport yet */ })
  await system.addAgentToRoom(you.id, room.profile.id, 'seed')
}
