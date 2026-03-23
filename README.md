# Talking Agents

A multi-agent room communication system where AI and human agents converse and cooperate through rooms.

> **v0.1.0-alpha** — Core engine complete. No UI yet (Phase 3).

## Architecture

Three things:

```
House            — collection of Rooms (pure data structures)
Team             — collection of Agents (AI + human, unified interface)
postAndDeliver() — one function that routes messages to rooms and/or agents
```

### Key Concepts

- **Rooms** are pure data structures — an array of messages with a profile. No delivery logic, no dependencies.
- **Agents** are self-contained — each maintains its own message history, room profiles, and agent profiles. AI agents use LLMs to decide responses; human agents relay messages via transport (WebSocket in Phase 3).
- **Direct messaging** — agents can message each other directly without going through a room. Room messages and DMs use the same delivery mechanism.
- **No membership lists** — room participants are derived from message senders.
- **Profiles, not registries** — agents learn about other agents from join message metadata. No centralized coordination.

### How It Works

1. A message arrives in a room (or as a DM)
2. The room returns recipient IDs (derived from who has posted there)
3. `postAndDeliver` delivers to each recipient via `team.get(id).receive(message)`
4. AI agents evaluate whether to respond (cooldown, context building, LLM call)
5. The LLM returns JSON with a `target` specifying where to send the response
6. `postAndDeliver` routes the response to the targeted rooms and/or agents

### Agent Self-Containment

Each agent maintains three data structures internally:

- **messages[]** — all messages from all rooms and DMs
- **roomProfiles** — metadata for each room the agent is in
- **agentProfiles** — metadata for each agent it has encountered

No external queries needed. Everything is derived from the agent's own data.

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [Ollama](https://ollama.ai) running locally with at least one model pulled
- TypeScript 5+

## Quick Start

```bash
# Install dependencies
bun install

# Pull a model (if not already done)
ollama pull llama3.2

# Type check
bun run check

# Run unit tests (no Ollama needed)
bun run test:unit

# Run all tests (requires Ollama with llama3.2)
bun test
```

## Usage Example

```typescript
import { createHouse, initIntroductionsRoom } from './src/core/house.ts'
import { createTeam } from './src/agents/team.ts'
import { createHumanAgent } from './src/agents/human-agent.ts'
import { spawnAIAgent, spawnHumanAgent } from './src/agents/spawn.ts'
import { createOllamaProvider } from './src/llm/ollama.ts'
import type { Message, MessageTarget, PostAndDeliver } from './src/core/types.ts'

// Create the system
const house = createHouse()
const team = createTeam()
const intro = initIntroductionsRoom(house)
const ollama = createOllamaProvider('http://localhost:11434')

// Wire delivery
const deliver = (id: string, msg: Message) => {
  try { team.get(id)?.receive(msg) } catch (e) { console.error(e) }
}

const postAndDeliver: PostAndDeliver = (target, params) => {
  const correlationId = crypto.randomUUID()
  const delivered: Message[] = []

  for (const roomId of target.rooms ?? []) {
    const room = house.getRoom(roomId)
    if (!room) continue
    const { message, recipientIds } = room.post({ ...params, correlationId })
    delivered.push(message)
    for (const id of recipientIds) deliver(id, message)
  }

  for (const agentId of target.agents ?? []) {
    if (agentId === params.senderId) continue
    const dm: Message = {
      id: crypto.randomUUID(), recipientId: agentId,
      senderId: params.senderId, content: params.content,
      timestamp: Date.now(), type: params.type, correlationId,
    }
    delivered.push(dm)
    deliver(agentId, dm)
    deliver(params.senderId, dm)
  }

  return delivered
}

// Spawn an AI agent
await spawnAIAgent({
  participantId: 'analyst-1',
  name: 'Analyst',
  description: 'Analyzes data and identifies patterns',
  model: 'llama3.2',
  systemPrompt: 'You are a data analyst. Be concise and precise.',
  cooldownMs: 10000,
}, ollama, house, team, postAndDeliver)

// Spawn a human agent
const human = createHumanAgent(
  { id: 'alice', name: 'Alice', description: 'A researcher' },
  (msg) => console.log(`[${msg.senderId}]: ${msg.content}`),
)
await spawnHumanAgent(human, house, team, postAndDeliver, [intro])

// Human posts a message
postAndDeliver(
  { rooms: [intro.profile.id] },
  { senderId: 'alice', content: 'What patterns do you see in the data?', type: 'chat' },
)
```

## Project Structure

```
src/
  core/
    types.ts          — All interfaces and type definitions
    room.ts           — Room: pure data structure (messages + profile)
    house.ts          — House: room collection
  agents/
    team.ts           — Team: agent collection
    ai-agent.ts       — AI agent factory (LLM-powered)
    human-agent.ts    — Human agent factory (transport-powered)
    actions.ts        — Self-management action executor
    spawn.ts          — Agent wiring (create + register + join)
    shared.ts         — Shared utilities (profile extraction, join metadata)
  llm/
    ollama.ts         — Ollama LLM provider
```

## Docker

```bash
# Build
docker build -t talking-agents .

# Run (requires Ollama accessible from container)
docker run -p 3000:3000 -e OLLAMA_URL=http://host.docker.internal:11434 talking-agents
```

GitHub Actions automatically builds and pushes a Docker image to `ghcr.io` on every push to `main`.

## Roadmap

- [x] **Phase 1** — Core: rooms, house, types, LLM provider
- [x] **Phase 2** — Agents: AI + human agents, team, spawn, actions, DMs
- [ ] **Phase 3** — Server + UI: HTTP server, WebSocket, browser interface
- [ ] **Phase 4** — Attention modes, tool use framework

## License

MIT
