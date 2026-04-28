// ============================================================================
// First-run seeding — populate a freshly-created instance with one room and
// one agent so an invited user lands on something they can immediately try,
// instead of an empty sidebar that says "Create a room to get started."
//
// Called by SystemRegistry.buildSystem when no snapshot existed on disk.
// Skipped when SAMSINN_SEED_EXAMPLE=0 (tests, operators who prefer empty).
//
// Choices:
// - One room ("demo") with a friendly roomPrompt explaining the sandbox.
// - One AI agent ("Helper") on claude-haiku-4-5 — the cheapest cloud option
//   and a sensible default for sandbox deploys. If the operator hasn't
//   configured ANTHROPIC_API_KEY, the user will get a clear provider error
//   on first send and the ⛓ red dot will already be screaming. That is a
//   better failure mode than an empty House.
// - One system-type welcome message with three try-this prompts.
//
// We do NOT seed scripts, skills, or artifacts — those are advanced and the
// invitee should discover them via the room prompt + getting-started doc.
// ============================================================================

import type { System } from '../main.ts'

// Default model for the seeded Helper agent. Override via SAMSINN_SEED_MODEL
// to match your configured providers (e.g. 'gemini-2.5-flash-lite',
// 'groq:llama-3.3-70b-versatile', 'gpt-4o-mini'). If the configured value
// isn't reachable, the user gets a clear provider error on first chat.
const SEED_MODEL = process.env.SAMSINN_SEED_MODEL || 'claude-haiku-4-5'

const HELPER_PERSONA = [
  'You are Helper, a friendly guide for someone trying Samsinn for the first time.',
  'Keep replies short (1-3 sentences). Be warm, curious, and concrete.',
  'When asked what Samsinn does, explain in plain language: a room where multiple AI agents and people talk together, with shared todos, documents, and scripts.',
  'When asked what to try, suggest creating a second agent with a different persona and seeing how they interact.',
].join(' ')

const ROOM_PROMPT = [
  'This is a sandbox demo room. The user is new to Samsinn.',
  'Be welcoming. If you see no recent activity, you can ask "what would you like to explore first?"',
].join(' ')

const WELCOME_MESSAGE = [
  '👋 Welcome to Samsinn — a multi-agent sandbox.',
  '',
  'This **demo** room has one agent (**Helper**) ready to chat. Three things to try:',
  '',
  '1. Type `hi` and hit Send — Helper will reply.',
  '2. Add a second agent (sidebar → **+** next to **Agents**) and watch them talk to each other.',
  '3. Address one specifically with `[[Helper]] your question` — only that agent replies.',
  '',
  'Stuck? The 📋 icon on any message shows exactly what the agent saw. The 🐛 icon in this header reports issues.',
  '',
  'This sandbox may be reset without notice. Don\'t paste secrets.',
].join('\n')

export const seedFreshInstance = async (system: System): Promise<void> => {
  if (process.env.SAMSINN_SEED_EXAMPLE === '0') return

  // Defensive: never seed into a non-empty House.
  if (system.house.listAllRooms().length > 0) return
  if (system.team.listAgents().length > 0) return

  try {
    const room = system.house.createRoom({
      name: 'demo',
      roomPrompt: ROOM_PROMPT,
      createdBy: 'system',
    })

    const helper = await system.spawnAIAgent({
      name: 'Helper',
      model: SEED_MODEL,
      persona: HELPER_PERSONA,
    })

    await system.addAgentToRoom(helper.id, room.profile.id)

    room.post({
      senderId: 'system',
      content: WELCOME_MESSAGE,
      type: 'system',
    })
  } catch (err) {
    // Seeding is best-effort. A failure (e.g. provider router rejecting
    // an unknown model prefix in an exotic deploy) must not block the
    // instance from coming up. Log loudly so the operator can investigate.
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[seed] fresh-instance seeding failed (continuing with empty House): ${reason}`)
  }
}
