# Samsinn

A multi-agent room communication system where AI and human agents converse and cooperate through rooms, direct messages, and orchestrated flows.

> **v0.5.7** — Simplified data model (no descriptions), room pause dots, onMessagePosted callback, delivery-modes refactor.

## Architecture

Three things:

```
House            — collection of Rooms (self-contained components with delivery)
Team             — collection of Agents (AI + human, unified interface)
routeMessage()   — one function that routes messages to rooms and/or agents
```

### Delivery Modes

Each room has exactly one active delivery mode:

| Mode | Behavior |
|------|----------|
| **Broadcast** | Deliver to all non-muted members (default) |
| **Targeted** | No auto-delivery. Human selects agents per message via UI |
| **Staleness** | One-at-a-time delivery, agent who hasn't spoken longest goes first |
| **Flow** | Follow a predefined agent sequence with optional per-step prompts |

`[[AgentName]]` directed addressing and per-agent muting work in all modes.

### Key Concepts

- **Rooms** are self-contained components — messages + explicit members + delivery. `Room.post()` stores the message and dispatches delivery based on the active mode.
- **Agents** are unified — AI and human agents share the same interface. AI agents use LLMs; human agents relay via WebSocket.
- **Direct messaging** — agents can message each other outside rooms.
- **Flows** — user-defined sequences of agent steps with optional per-step prompts. Agents can appear multiple times. Flows can loop.
- **Muting** — per-agent, per-room mute that excludes agents from all delivery. Mute/unmute events appear in message history.
- **Plain text protocol** — AI agents respond in natural text. `::PASS::` to stay silent, `::TOOL::` for tool calls.
- **Markdown** — agents can use Markdown in responses; the UI renders it with sanitized HTML.

### How It Works

1. A message is posted to a room via `room.post()`
2. The room stores it, then dispatches based on the active delivery mode
3. In broadcast: all non-muted members receive it. In staleness: the stalest agent receives it. In flow: the next step agent receives it. In targeted: no auto-delivery.
4. AI agents evaluate and respond via LLM; responses route back through `routeMessage()`
5. `[[AgentName]]` in any message overrides the mode — delivers only to addressed agents

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [Ollama](https://ollama.ai) running locally (or remote via `OLLAMA_URL`)
- TypeScript 5+

## Quick Start

```bash
bun install
ollama pull llama3.2
bun run start
```

Open `http://localhost:3000` in your browser. Enter your name. Create AI agents, switch delivery modes, build flows.

```bash
# Tests
bun run test:unit   # no Ollama needed
bun test            # full suite (requires Ollama)
bun run check       # TypeScript type check
```

## Project Structure

```
src/
  core/
    types.ts            — All interfaces and type definitions
    room.ts             — Room: self-contained component (messages + members + delivery modes)
    house.ts            — House: room collection with house prompts
    delivery.ts         — routeMessage: routes to rooms and DMs
    delivery-modes.ts   — Pure functions for broadcast, targeted, staleness, flow delivery
    staleness.ts        — Staleness calculation (who hasn't spoken longest)
    addressing.ts       — [[AgentName]] parser
    tool-registry.ts    — Global tool store
    names.ts            — Name uniqueness utilities
  agents/
    ai-agent.ts         — AI agent factory with two-buffer architecture
    context-builder.ts  — LLM context assembly (history, prompts, step instructions)
    evaluation.ts       — LLM interaction + ReAct tool loop
    human-agent.ts      — Human agent factory (WebSocket transport)
    team.ts             — Agent collection
    actions.ts          — Self-management action runner
    spawn.ts            — Agent wiring (create + register + join)
  llm/
    ollama.ts           — Ollama HTTP client with timing
  tools/
    built-in.ts         — list_rooms, get_time, query_agent
  integrations/
    mcp/
      client.ts         — MCP client: consumes external tool servers
      server.ts         — MCP server: exposes Samsinn as tools for external LLMs
  api/
    server.ts           — Bun.serve: HTTP + WebSocket + static files
    http-routes.ts      — REST API endpoints
    ws-handler.ts       — WebSocket message dispatch
  ui/
    index.html          — Browser UI (Tailwind + marked + DOMPurify)
    modules/
      app.ts            — Main app orchestrator
      ws-client.ts      — WebSocket client
      ui-renderer.ts    — DOM rendering (messages, agents, modals, flow editor)
  main.ts               — createSystem() factory + startup entry point
```

## API

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | System health + Ollama status |
| GET/PUT | `/api/house/prompts` | House prompt + response format |
| GET/POST/DELETE | `/api/rooms/:name` | Room CRUD |
| PUT | `/api/rooms/:name/delivery-mode` | Set delivery mode |
| PUT | `/api/rooms/:name/mute` | Mute/unmute agent |
| POST | `/api/rooms/:name/deliver-to` | Targeted delivery |
| PUT | `/api/rooms/:name/staleness/pause` | Pause/resume staleness |
| POST/GET | `/api/rooms/:name/flows` | Flow CRUD |
| POST | `/api/rooms/:name/flows/start` | Start a flow |
| GET/POST/PATCH/DELETE | `/api/agents/:name` | Agent CRUD |
| POST | `/api/messages` | Post message |

### WebSocket Protocol

Connect: `ws://localhost:3000/ws?name=YourName`

## Headless Mode (MCP Server)

Samsinn can run without the browser UI as a pure MCP server on stdio. External LLMs and agents can orchestrate the entire system via MCP tools.

```bash
bun run headless
```

This exposes 22 tools (room/agent/message/flow management) and 3 resources (rooms, agents, room messages). Connect with any MCP client — Claude Desktop, Claude Code, or the MCP inspector:

```bash
npx @modelcontextprotocol/inspector bun run src/main.ts --headless
```

### Claude Desktop / Claude Code configuration

```json
{
  "mcpServers": {
    "samsinn": {
      "command": "bun",
      "args": ["run", "/path/to/samsinn/src/main.ts", "--headless"]
    }
  }
}
```

No human agent entity is needed in headless mode — use the `post_message` tool to inject messages and `get_room_messages` to read responses.

## Docker

```bash
docker build -t samsinn .
docker run -p 3000:3000 -e OLLAMA_URL=http://host.docker.internal:11434 samsinn
```

## Roadmap

- [x] **Phase 1** — Core: rooms, house, types, LLM provider
- [x] **Phase 2** — Agents: AI + human, team, spawn, actions, DMs
- [x] **Phase 3** — Server + UI: HTTP/WebSocket server, browser interface
- [x] **Phase 4** — Tool use framework: ReAct loop, MCP integration
- [x] **Phase 5** — Delivery modes: broadcast, targeted, staleness, flow, muting, addressing, Markdown
- [x] **Phase 6** — MCP server adapter (22 tools, 3 resources), headless mode (stdio)
- [ ] **Phase 7** — AI-initiated flows, flow editor enhancements

## License

MIT
