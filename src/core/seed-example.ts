// ============================================================================
// First-run seeding — populate a freshly-created instance with one room and
// two agents (one AI, one human) so a visitor can immediately post.
//
// Called by SystemRegistry.buildSystem when no snapshot existed on disk.
// Skipped when SAMSINN_SEED_EXAMPLE=0 (tests, operators who prefer empty).
//
// Shape:
// - One room ("Cafe") with a friendly roomPrompt.
// - One AI agent ("AI") on the configured seed model.
// - One human agent ("Human") with a no-op transport. The UI binds to this
//   human as the default poster; user can rename, add more, or pick another.
// - One system-type welcome message with try-this prompts.
//
// The shape here is the single source of truth for `isEmptySnapshot` in
// snapshot.ts — when seed produces this exact shape, we treat the snapshot
// as "skippable" so cookieless drive-by visits don't accumulate dirs.
// ============================================================================

import type { System } from '../main.ts'
import { CURATED_MODELS } from '../llm/models/catalog.ts'
import { resolveDefaultModel, type ProviderSnapshot } from '../llm/models/default-resolver.ts'

// Pick the seed model from live provider state so a fresh instance lands on
// a provider the user actually has a key for. Walks the same preference
// order /api/models uses, but treats only enabled providers as candidates —
// avoids the historical bug where the seed hardcoded `claude-haiku-4-5` and
// fresh instances on Gemini-only setups failed every first eval.
//
// Override with SAMSINN_SEED_MODEL when you want a specific model regardless
// of provider state.
const pickSeedModel = (system: System): string => {
  const override = process.env.SAMSINN_SEED_MODEL
  if (override && override.trim()) return override.trim()
  // Build snapshots: `ok` iff the provider has an effective key (cloud) or
  // is configured (ollama). Cooldowns aren't meaningful at seed time.
  const names = new Set<string>([...Object.keys(CURATED_MODELS), 'ollama'])
  const providers: ProviderSnapshot[] = [...names].map(name => {
    const enabled = name === 'ollama' ? !!system.ollama : system.providerKeys.isEnabled(name)
    return {
      name,
      status: enabled ? 'ok' : 'no_key',
      models: (CURATED_MODELS[name] ?? []).map(m => ({ id: m.id })),
    }
  })
  return resolveDefaultModel(providers) || 'gemini-2.5-pro'
}

const AI_PERSONA = [
  'You are AI, a friendly companion in the Cafe.',
  'Keep replies short (1-3 sentences). Be warm, curious, and concrete.',
  'When asked what Samsinn does, explain in plain language: a room where multiple AI agents and people talk together, with shared todos, documents, and scripts.',
  'When asked what to try, suggest creating a second agent with a different persona and seeing how they interact.',
].join(' ')

const ROOM_PROMPT = [
  'This is the Cafe — a relaxed sandbox room.',
  'Be welcoming. If you see no recent activity, you can ask "what would you like to explore first?"',
].join(' ')

const buildWelcomeMessage = (wikiNames: ReadonlyArray<string>): string => {
  const wikiLine = wikiNames.length === 0
    ? ''
    : wikiNames.length === 1
      ? `5. AI can look things up in the **${wikiNames[0]}** wiki — just ask.`
      : `5. AI can look things up in these wikis — just ask: ${wikiNames.map(n => `**${n}**`).join(', ')}.`
  return [
    '👋 Welcome to the Cafe.',
    '',
    'You have one AI companion (**AI**) and one human seat (**Human**) here. A few things to try:',
    '',
    '1. Type a message and hit Send — AI will reply, attributed to **Human**.',
    '2. Click your name in the sidebar to rename yourself.',
    '3. Add another human (sidebar → **+** next to **Agents**, kind=human) and click their dot to post as them.',
    '4. Address an agent with `[[AI]] your question` — only they reply.',
    ...(wikiLine ? [wikiLine] : []),
    '',
    'Click the agent name in the sidebar to inspect them. The 🐛 icon in the header reports issues.',
  ].join('\n')
}

// Constants exported so isEmptySnapshot can match the seed shape exactly.
export const SEED_ROOM_NAME = 'Cafe'
export const SEED_AI_NAME = 'AI'
export const SEED_HUMAN_NAME = 'Human'

export const seedFreshInstance = async (system: System): Promise<void> => {
  if (process.env.SAMSINN_SEED_EXAMPLE === '0') return

  // Defensive: never seed into a non-empty House.
  if (system.house.listAllRooms().length > 0) return
  if (system.team.listAgents().length > 0) return

  try {
    const room = system.house.createRoom({
      name: SEED_ROOM_NAME,
      roomPrompt: ROOM_PROMPT,
      createdBy: 'system',
    })

    const ai = await system.spawnAIAgent({
      name: SEED_AI_NAME,
      model: pickSeedModel(system),
      persona: AI_PERSONA,
    })

    // Human agent: no-op transport. Real WS clients route messages via the
    // instance broadcast (wireSystemEvents); the human's per-agent transport
    // is only used for direct delivery, which the seeded agent doesn't need
    // until a UI tab attaches one (currently: never, since WS no longer
    // binds to a single agent in the new model).
    const human = await system.spawnHumanAgent(
      { name: SEED_HUMAN_NAME },
      () => { /* no-op */ },
    )

    await system.addAgentToRoom(ai.id, room.profile.id)
    await system.addAgentToRoom(human.id, room.profile.id)

    // Bind every wiki the registry knows about so a brand-new visitor can ask
    // questions answered from the wiki without first learning where wiki
    // bindings live in the UI. Power users can unbind via the room settings.
    // If discovery hasn't surfaced any wikis yet (no SAMSINN_WIKI_SOURCES,
    // empty registry), this is a clean no-op.
    const wikiList = system.wikiRegistry.list()
    const wikiIds = wikiList.map(w => w.id)
    if (wikiIds.length > 0) room.setWikiBindings(wikiIds)

    room.post({
      senderId: 'system',
      content: buildWelcomeMessage(wikiList.map(w => w.displayName)),
      type: 'system',
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[seed] fresh-instance seeding failed (continuing with empty House): ${reason}`)
  }
}
