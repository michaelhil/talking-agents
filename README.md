# Samsinn

**A multi-agent collaboration system.** Spawn AI agents, put them in rooms, let them think together — or orchestrate them programmatically through the REST API, WebSocket protocol, or as an MCP server.

> v0.6.0 — [Changelog](#changelog)

---

## What you can do with it

- **Run a panel of AI specialists** — a Researcher, Analyst, and Writer in the same room, bouncing ideas off each other and you
- **Automate multi-step workflows** — define a Flow (ordered agent sequence) and trigger it with a single message
- **Track tasks collaboratively** — agents and humans share a todo list per room; agents complete todos and record results
- **Give agents tools** — agents can search the web, do math, remember facts across sessions, delegate subtasks, manage rooms, and query each other
- **Self-extending agents** — agents create Skills (behavioral templates) and write new tools at runtime, making the system grow its own capabilities
- **Embed in your own LLM workflow** — run headless as an MCP server; external LLMs orchestrate everything via 23 tools
- **Integrate programmatically** — full REST API + WebSocket protocol for building your own UI or automation

---

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Start Ollama with a model
ollama pull llama3.2

# 3. Start Samsinn
bun run start
```

Open **http://localhost:3000** in your browser.

1. Enter your name to join as a human agent
2. Click **+ Agent** to create an AI agent (give it a name, pick a model, write a system prompt)
3. Click **+ Room** to create a room
4. Add yourself and the agent to the room
5. Start talking

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.0 | Runtime and package manager |
| [Ollama](https://ollama.ai) | any | Runs AI models locally |

Ollama can run remotely — set `OLLAMA_URL=http://your-server:11434`.

No cloud services, no API keys, no accounts. Everything runs locally.

---

## Core Concepts

### Rooms

A room is a shared conversation space. Agents must be explicitly added to a room. Messages are stored and history is preserved across restarts (auto-saved snapshot).

Each room has:
- A **name** and optional **room prompt** (instructions all agents in the room receive in their context)
- An explicit **member list**
- A **delivery mode** (`broadcast` or `flow`)
- A **shared todo list**
- Optional **flows** (orchestration sequences)

### Agents

Agents are either **AI** (powered by an Ollama model) or **human** (you, via the browser). Both implement the same interface — they can join rooms, receive messages, respond, and use tools.

AI agents have:
- A **system prompt** (editable at any time)
- A **model** (switchable without restarting)
- An **activity state** (`idle` or `generating`) visible in the UI as a pulsing dot

### Delivery Modes

Controls which agents receive each message in a room:

| Mode | Who receives each message |
|---|---|
| **Broadcast** | Every non-muted member (default) |
| **Flow** | One agent at a time, in a predefined sequence |
| **Manual** | Humans only — AI peers are skipped; each AI is activated explicitly via a ▶ button on its chip |

**Directed addressing** — write `[[AgentName]]` anywhere in a message to override the mode and deliver only to that agent. Inert in manual mode (only the explicit ▶ click fires an agent).

**Manual turn-taking** — switching a room into `manual` cancels any in-flight AI generation in that room, then holds every subsequent message until the user clicks ▶ on a specific AI chip. The activated agent catches up on any messages it missed and takes exactly one turn. Humans can post as many messages as they like between activations.

**Muting** — mute any agent in any room from the UI. Muted agents are excluded from delivery in that room only.

**Pause** — pause a room to halt all delivery temporarily (useful while re-configuring it).

### Flows

A flow is an ordered sequence of agents. When a flow is active, each message from one step automatically triggers the next agent in sequence, until the flow completes (or loops).

Each step can have a **step prompt** — extra instructions injected only when that agent is processing its step.

Use cases:
- Review pipelines: Researcher → Analyst → Writer → Editor
- Iterative refinement: Agent A drafts, Agent B critiques, Agent A revises (looping)
- Sequential processing: each agent transforms the output of the previous one

### Todos

Every room has a shared task list visible to all members (human and AI). Agents see the todo list in their context and can create, update, and complete todos via tools.

Todo fields: content, status (`pending` / `in_progress` / `completed` / `blocked`), assignee, result (recorded when completed), dependencies.

The `delegate` tool creates a todo, sends the task to another agent, waits for the result, then marks the todo complete with the result — enabling tracked multi-agent task delegation.

### Agent Memory

Agents operate with two distinct memory layers:

**Session memory** is managed automatically. Each agent maintains a snapshot of the conversation history it has processed, plus an *incoming buffer* of messages it has received since its last response. When an agent responds, the buffer is flushed into the snapshot and tagged messages become history. The history is limited (`historyLimit`, default 50 messages per room), so when an agent joins a room with a long history it receives an LLM-generated summary as its first context. Session memory is in-process and is not persisted between restarts beyond what is stored in the snapshot.

**Persistent memory** is opt-in, via the `memory.ts` tools. These store data on the filesystem per-agent:

| Tool | Storage |
|---|---|
| `note` / `my_notes` | Append-only log at `~/.samsinn/memory/<name>/notes.log` |
| `remember` / `recall` / `forget` | Key-value store at `~/.samsinn/memory/<name>/facts.json` |
| `think` | Scratchpad (in-memory only — not stored) |

Persistent memory survives restarts and is completely independent of the room message history. An agent can `remember` a user preference or conclusion from one session and `recall` it in the next. Memory is private to each agent — one agent cannot read another's notes.

---

### Skills

A skill is a reusable behavioral template stored as a markdown file. Skills tell agents *how to approach* a category of task — they shape reasoning, not just capability.

Each skill is a directory under `~/.samsinn/skills/` containing a `SKILL.md` file (YAML frontmatter + markdown body) and an optional `tools/` subdirectory with bundled tool code:

```
~/.samsinn/skills/
  data-analyst/
    SKILL.md              ← behavioral instructions
    tools/                ← optional bundled tools
      analyze_csv.ts
  code-reviewer/
    SKILL.md
```

**SKILL.md format** (Claude Skills compatible):

```markdown
---
name: data-analyst
description: Use when asked to analyze data or metrics
scope: [research-room]
---

When analyzing data, follow these steps:
1. Identify the data source
2. Formulate queries using available tools
3. Summarize findings with citations
```

Skills are loaded at startup and injected into agent context as a dedicated `=== SKILLS ===` section. Scope controls which rooms see which skills — empty scope means global.

**Runtime skill creation** — agents can create new skills (`write_skill`) and bundle tools with them (`write_tool`) at runtime. Generated skills persist as files and survive restarts.

### Tools

Agents invoke tools using the `::TOOL::` syntax (or native function-calling on supported models):

```
::TOOL:: get_time
::TOOL:: query_agent {"agent": "Researcher", "question": "What did you find?"}
::TOOL:: calculate {"expression": "(150 * 12) / 52"}
```

After tool results are returned, the agent writes its final response. The entire tool loop is invisible to other room participants — only the final response appears.

See [Tool Reference](#tool-reference) below.

---

## Using the Browser UI

### Creating agents

Click **+ Agent** in the sidebar. Required fields:
- **Name** — unique, immutable
- **Model** — any Ollama model (e.g. `llama3.2`, `qwen2.5:14b`, `deepseek-r1:8b`)
- **System Prompt** — the agent's identity and instructions

You can edit the system prompt and model at any time by clicking the agent name.

### Creating rooms

Click **+ Room**. Optionally add a **Room Prompt** — a shared instruction that appears in every agent's context while they're in that room. Good for defining the room's purpose, constraints, or output format.

### Managing delivery

Click the **mode selector** (top of the room panel) to switch between broadcast, manual, and flow.

Each agent chip in the room header shows a status dot (green = idle, yellow = generating, grey = muted). Click the dot to toggle mute in that room. Hover the chip for the **×** to remove from the room. Use the **⏸** in the room panel to pause the room.

**Manual mode** adds a ▶ button to every AI agent chip. Clicking ▶ gives that agent exactly one turn with the current room state. Muted agents' ▶ is hidden.

**Bookmarks** — the 🔖 toolbar button opens a system-wide bookmark list. Hover any message to see its own 🔖 icon; click to add the message text to the list. Rows support in-line edit (pen) and delete (×). Clicking a row sends the text to the current room as a human message.

The sidebar agent list has a hover-reveal **×** on each row for deleting the agent entirely.

### Flows

Open the **Flow Editor** (link in the room header). Create a flow by selecting agents in order, optionally writing per-step prompts. Start a flow by selecting it and sending a trigger message.

### Todos

The **Todos** panel (collapsible, below the room header) shows all tasks for the current room. Add todos manually or let agents create and complete them via the `delegate` tool.

---

## Tool Reference

### Built-in tools (always available)

Every agent can use these tools by listing them in its `tools` config field.

| Tool | What it does |
|---|---|
| `get_time` | Current date/time (ISO 8601) |
| `list_rooms` | All rooms in the system |
| `list_agents` | All agents (AI + human), kind, and model |
| `get_my_context` | Caller's identity, rooms they're in |
| `query_agent` | Ask another AI agent a direct question |
| `delegate` | Assign a task to another agent; auto-creates and tracks a todo |
| `list_todos` | Current room's todo list |
| `add_todo` | Create a todo (optionally assign to an agent) |
| `update_todo` | Set status, record a result, reassign |
| `create_room` | Create a room (caller auto-joins) |
| `delete_room` | Permanently delete a room |
| `add_to_room` | Add an agent (or yourself) to a room |
| `remove_from_room` | Remove an agent (or yourself) |
| `set_delivery_mode` | Switch room to broadcast |
| `pause_room` | Pause or unpause delivery |
| `mute_agent` | Mute or unmute an agent in a room |
| `set_room_prompt` | Update the room's shared instructions |
| `post_to_room` | Post a message to a different room |
| `get_room_history` | Recent messages from a room |
| `write_skill` | Create a new skill (SKILL.md + directory) |
| `write_tool` | Generate an executable tool inside a skill's tools/ dir |
| `list_skills` | List all loaded skills with scope and bundled tools |

Full documentation, parameters, and usage guidance: [`docs/tools.md`](docs/tools.md)

### Assigning tools to an agent

In the **Create Agent** modal (or via API), list tool names in the `tools` field:

```json
{
  "name": "Researcher",
  "model": "qwen2.5:14b",
  "persona": "You are a research assistant...",
  "tools": ["get_time", "query_agent", "delegate", "list_todos", "add_todo", "update_todo", "arxiv_search", "fetch_url"]
}
```

### External tools (filesystem-loaded)

Drop a `.ts` file in `./tools/` (project-local) or `~/.samsinn/tools/` (user-global). It is loaded at startup and available to any agent that lists it by name. Tools can also be bundled with skills in `~/.samsinn/skills/<name>/tools/`. See [`docs/tools.md#adding-external-tools`](docs/tools.md#adding-external-tools).

**Bundled in `tools/`:**

| File | Tools |
|---|---|
| `memory.ts` | `think`, `note`, `my_notes`, `remember`, `recall`, `forget` |
| `compute.ts` | `calculate`, `json_extract`, `format_table` |
| `web.ts` | `web_search`†, `fetch_url` |
| `research.ts` | `arxiv_search`, `doi_lookup`, `semantic_scholar` |

†`web_search` requires `BRAVE_API_KEY` or `SERPER_API_KEY`.

---

## Configuration

All configuration is via environment variables. No config file is required.

### Core

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `PORT` | `3000` | HTTP/WebSocket port |
| `BRAVE_API_KEY` | — | Enables `web_search` via Brave |
| `SERPER_API_KEY` | — | Enables `web_search` via Serper (alternative to Brave) |
| `SAMSINN_TOOLS_DIR` | — | Custom directory for external tools |

Snapshot is saved to `data/snapshot.json` and auto-restored on startup.

### Cloud LLM providers (optional)

Samsinn routes LLM calls through a provider router that can fall over between cloud providers on rate-limit / quota errors. With no cloud API keys set, only Ollama is used — identical to the original behaviour. Setting any API key below enables that provider; the router picks up the change at next start.

All supported cloud providers only require email (or SSO) signup — no credit card, no phone verification.

| Variable | Default | Description |
|---|---|---|
| `PROVIDER` | — | Set to `ollama` to pin to single-Ollama mode (ignores cloud keys even if set) |
| `PROVIDER_ORDER` | `cerebras,groq,openrouter,mistral,sambanova,ollama` | Comma-separated priority order. Unconfigured names are silently dropped with a startup log line |
| `DEFAULT_PROVIDER_CONCURRENT` per-provider | 2–3 | Per-provider concurrency caps (see below) |
| `CEREBRAS_API_KEY` | — | Enables Cerebras (Qwen3 235B, GPT-OSS-120B, ~1000 tok/s) |
| `GROQ_API_KEY` | — | Enables Groq (Llama 3.3, Kimi K2, Llama 4 Scout, ...) |
| `OPENROUTER_API_KEY` | — | Enables OpenRouter free tier (DeepSeek R1, Llama 3.3 70B, ...) |
| `MISTRAL_API_KEY` | — | Enables Mistral La Plateforme (EU-based) |
| `SAMBANOVA_API_KEY` | — | Enables SambaNova Cloud |
| `<NAME>_MAX_CONCURRENT` | 2 (Cerebras), 3 (Groq), 1 (OpenRouter), 2 (Mistral/SambaNova) | Max concurrent requests per provider |
| `FORCE_PROVIDER_FAIL` | — | Test hook — forces the named provider to fail (exercises failover) |

**Model names** can be bare (`llama-3.3-70b`) — the router tries each provider in order, skipping ones that don't serve it — or provider-prefixed (`groq:llama-3.3-70b`) to pin to a specific provider with no failover. OpenRouter slugs with colons work because the prefix parser splits on the **first** colon only (`openrouter:meta-llama/llama-3.3-70b-instruct:free`).

**Failover behaviour**: on rate-limit (429) or 5xx, the router marks the provider cold (using `Retry-After` when present) and falls through to the next. Auth errors (401/403 without a quota body) propagate without fallback — that's a config problem, not a capacity problem. Once a call succeeds on a non-preferred provider, subsequent calls for the same model prefer it until it fails, to prevent ping-pong.

**UI notifications**: when the active provider for an agent changes, the browser shows a green toast (`Agent: now using groq:llama-3.3-70b`). All-provider failures show a red toast. Mid-stream failures show a "stream interrupted" warning — partial output in the message is preserved, no automatic retry.

**User-initiated model changes** are verified on next turn: saving a new model in the agent inspector shows a "saved — verifying…" toast, replaced by the verified/failed toast when the agent next generates. A 30-second timeout falls back to a neutral "will verify when agent runs next" message if the agent is idle.

### Managing provider keys from the UI

Click **Providers** in the sidebar to open the unified dashboard. Cloud providers are at the top; Ollama below. For each cloud provider:

- **Paste a key** into the masked field and hit **Save** — the key is stored in `~/.samsinn/providers.json` (mode 0600). Changes **require restart** — the banner at the top of the dashboard has a "Restart now" button (invokes `POST /api/system/shutdown`; your orchestrator like `bun --watch`, docker, or systemd respawns the process).
- **Test** validates the key against the provider's `/models` endpoint before you save — no tokens consumed.
- **Clear** removes the stored key (leaves env vars untouched).
- **Source badge** shows where the active key comes from: `ENV` (environment variable wins; UI is read-only), `STORED` (from `providers.json`), or `—` (none configured).

**Precedence:** `<NAME>_API_KEY` env var > stored key in `providers.json` > none. This lets CI / headless deployments pin keys via env while interactive users manage them through the UI.

**Security notes:**
- `providers.json` is set to mode 0600 on every write; a warning is logged if it's found with wider permissions.
- Keys are never returned by `GET /api/providers` (only a masked last-4 form), never serialized to `data/snapshot.json`, never sent over the WebSocket.
- Writes are atomic (temp-file + rename), so a crash mid-save won't corrupt the file.

---

## Headless Mode (MCP Server)

Run without the browser UI as a pure MCP server. An external LLM (Claude, GPT-4, etc.) can orchestrate the entire system through 23 MCP tools.

```bash
bun run headless
```

Connect with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector bun run src/main.ts --headless
```

### Claude Desktop / Claude Code

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

### MCP tools exposed

**Room management:** `create_room`, `list_rooms`, `get_room`, `delete_room`, `set_room_prompt`

**Agent management:** `create_agent`, `list_agents`, `get_agent`, `remove_agent`, `update_agent_prompt`

**Messaging:** `post_message`, `get_room_messages`

**Membership:** `add_to_room`, `remove_from_room`

**Delivery control:** `set_delivery_mode`, `set_paused`, `set_muted`

**Flows:** `add_flow`, `list_flows`, `start_flow`, `cancel_flow`

**Todos:** `list_todos`, `add_todo`, `update_todo`

**House config:** `get_house_prompts`, `set_house_prompts`

**Resources:** `samsinn://rooms`, `samsinn://agents`, `samsinn://rooms/{name}/messages`

---

## REST API

Base URL: `http://localhost:3000`

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check, Ollama status, counts |
| `GET` | `/api/models` | Available Ollama models |
| `GET` | `/api/tools` | All registered tools |
| `GET` | `/api/house/prompts` | House prompt + response format |
| `PUT` | `/api/house/prompts` | Update house prompt / response format |

### Rooms

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/rooms` | List all rooms |
| `POST` | `/api/rooms` | Create room |
| `GET` | `/api/rooms/:name` | Room profile + recent messages |
| `DELETE` | `/api/rooms/:name` | Delete room |
| `PUT` | `/api/rooms/:name/prompt` | Update room prompt |
| `GET` | `/api/rooms/:name/members` | List members |
| `POST` | `/api/rooms/:name/members` | Add agent to room |
| `DELETE` | `/api/rooms/:name/members/:agentName` | Remove agent from room |
| `PUT` | `/api/rooms/:name/delivery-mode` | Set delivery mode (`broadcast` / `manual`) |
| `PUT` | `/api/rooms/:name/pause` | Pause / unpause |
| `PUT` | `/api/rooms/:name/mute` | Mute / unmute agent |
| `POST` | `/api/rooms/:name/agents/:agentName/activate` | Manual mode — catch the agent up and force one turn |

### Flows

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/rooms/:name/flows` | List flows |
| `POST` | `/api/rooms/:name/flows` | Create flow |
| `POST` | `/api/rooms/:name/flows/start` | Start flow |
| `POST` | `/api/rooms/:name/flows/cancel` | Cancel active flow |

### Todos

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/rooms/:name/todos` | List todos |
| `POST` | `/api/rooms/:name/todos` | Add todo |
| `PUT` | `/api/rooms/:name/todos/:todoId` | Update todo |
| `DELETE` | `/api/rooms/:name/todos/:todoId` | Remove todo |

### Agents

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create AI agent |
| `GET` | `/api/agents/:name` | Agent details (includes `tags` for both AI and human) |
| `PATCH` | `/api/agents/:name` | Update persona / model / tags / description |
| `DELETE` | `/api/agents/:name` | Remove agent |
| `GET` | `/api/agents/:name/rooms` | Rooms agent is in |
| `POST` | `/api/agents/:name/cancel` | Cancel active generation |

### Messages

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/messages` | Post a message to rooms or agents |

### Bookmarks

System-wide message bookmarks, persisted in the snapshot. Newest bookmarks are returned first.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/bookmarks` | List all bookmarks |
| `POST` | `/api/bookmarks` | Create bookmark `{ content }` |
| `PUT` | `/api/bookmarks/:id` | Update content |
| `DELETE` | `/api/bookmarks/:id` | Delete |

---

## WebSocket Protocol

Connect: `ws://localhost:3000/ws?name=YourName`

On connection, the server sends a `snapshot` message with the full current state (rooms, agents, your agent ID, session token).

### Inbound (client → server)

```typescript
{ type: 'post_message';     target: { rooms?: string[], agents?: string[] }; content: string }
{ type: 'create_room';      name: string; roomPrompt?: string }
{ type: 'add_to_room';      roomName: string; agentName: string }
{ type: 'remove_from_room'; roomName: string; agentName: string }
{ type: 'create_agent';     config: AIAgentConfig }
{ type: 'remove_agent';     name: string }
{ type: 'update_agent';     name: string; persona?: string; model?: string }
{ type: 'set_delivery_mode'; roomName: string; mode: 'broadcast' | 'manual' }
{ type: 'activate_agent';   roomName: string; agentName: string }
{ type: 'set_paused';       roomName: string; paused: boolean }
{ type: 'set_muted';        roomName: string; agentName: string; muted: boolean }
{ type: 'add_flow';         roomName: string; name: string; steps: FlowStep[]; loop?: boolean }
{ type: 'remove_flow';      roomName: string; flowId: string }
{ type: 'start_flow';       roomName: string; flowId: string; content: string }
{ type: 'cancel_flow';      roomName: string }
{ type: 'cancel_generation'; name: string }
{ type: 'add_todo';         roomName: string; content: string; assignee?: string; dependencies?: string[] }
{ type: 'update_todo';      roomName: string; todoId: string; status?: TodoStatus; assignee?: string; content?: string; result?: string }
{ type: 'remove_todo';      roomName: string; todoId: string }
```

### Outbound (server → client)

```typescript
{ type: 'snapshot';          rooms: RoomProfile[]; agents: AgentProfile[]; agentId: string; sessionToken?: string }
{ type: 'message';           message: Message }
{ type: 'agent_state';       agentName: string; state: 'idle' | 'generating'; context?: string }
{ type: 'room_created';      profile: RoomProfile }
{ type: 'room_deleted';      roomName: string }
{ type: 'membership_changed'; roomName: string; agentName: string; action: 'added' | 'removed' }
{ type: 'agent_joined';      agent: AgentProfile }
{ type: 'agent_removed';     agentName: string }
{ type: 'delivery_mode_changed'; roomName: string; mode: DeliveryMode; paused: boolean }
{ type: 'mute_changed';      roomName: string; agentName: string; muted: boolean }
{ type: 'activation_result'; roomName: string; agentName: string; ok: boolean; queued: boolean; reason?: string }
{ type: 'turn_changed';      roomName: string; agentName?: string; waitingForHuman?: boolean }
{ type: 'flow_event';        roomName: string; event: 'started' | 'step' | 'completed' | 'cancelled'; detail?: Record<string, unknown> }
{ type: 'todo_changed';      roomName: string; action: 'added' | 'updated' | 'removed'; todo: TodoItem }
{ type: 'error';             message: string }
```

---

## Agent Text Protocol

AI agents receive messages and respond in plain text. Two special prefixes are recognised:

| Prefix | Meaning |
|---|---|
| *(any text)* | Normal chat response |
| `::PASS::` | Stay silent this turn |
| `::TOOL:: tool_name {"param": "value"}` | Invoke a tool |

Tool calls may chain — the agent can call multiple tools before writing its final response. The full tool loop is invisible to room participants; they see only the final response.

Models with native function-calling (e.g. `qwen2.5`, `llama3.1`) use the OpenAI tool-calling format instead of `::TOOL::`. Capability is detected automatically via the Ollama `/api/show` endpoint.

`[[AgentName]]` anywhere in a message targets delivery to that specific agent, overriding the room's delivery mode.

---

## Project Structure

```
src/
  core/
    types.ts              — All type definitions (Message, Room, Agent, Flow, Todo, …)
    room.ts               — Room: messages, member management, delivery dispatch
    room-todos.ts         — Per-room todo store (CRUD operations)
    room-flows.ts         — Per-room flow store (flow lifecycle + step advancement)
    house.ts              — House: room collection + house-level prompts
    delivery.ts           — routeMessage(): routes to rooms and agent DMs
    delivery-modes.ts     — Broadcast and flow delivery implementations
    addressing.ts         — [[AgentName]] directed addressing parser
    tool-registry.ts      — Tool store: register, registerAll, get, list, has
    snapshot.ts           — System serialisation + versioned restore (JSON file)
    names.ts              — Name uniqueness and case-insensitive lookups
  agents/
    ai-agent.ts           — AI agent factory: AgentHistory, ReAct loop
    concurrency.ts        — Agent concurrency manager: generation tracking + idle detection
    human-agent.ts        — Human agent factory: WebSocket relay
    context-builder.ts    — LLM context assembly: history + prompts + tools + todos
    evaluation.ts         — LLM call + tool execution loop (with result truncation)
    team.ts               — Agent collection
    actions.ts            — Room join/leave with visible messages
    spawn.ts              — Agent creation + registration + tool wiring
    shared.ts             — Shared utilities (type guards, metadata helpers)
  llm/
    ollama.ts             — Ollama HTTP client with timing
    tool-capability.ts    — Per-model native tool-calling detection + cache
  tools/
    built-in/             — 19 built-in tools, grouped by domain
      room-tools.ts       — list_rooms, create/delete_room, set_room_prompt, pause_room, set_delivery_mode, add/remove_from_room
      agent-tools.ts      — list_agents, query_agent, mute_agent, delegate, get_my_context
      todo-tools.ts       — list_todos, add_todo, update_todo
      utility-tools.ts    — get_time, post_to_room, get_room_history
    format.ts             — Text-protocol tool formatting for system prompts
    loader.ts             — Filesystem tool discovery (./tools/, ~/.samsinn/tools/)
  skills/
    loader.ts             — Skill discovery, frontmatter parsing, bundled tool loading
  integrations/
    mcp/
      client.ts           — MCP client: consume external tool servers
      server.ts           — MCP server: expose Samsinn as 23 tools + 3 resources
      tools/              — MCP tool implementations (room, agent, todo, message)
      resources.ts        — MCP resource definitions (rooms, agents, messages)
  api/
    server.ts             — Bun.serve: HTTP + WebSocket + static file serving
    http-routes.ts        — REST dispatcher (routes to api/routes/ handlers)
    ws-handler.ts         — WebSocket session management + command dispatch
    routes/               — REST handlers grouped by resource
      rooms.ts            — /api/rooms and sub-paths
      agents.ts           — /api/agents and sub-paths
      messages.ts         — /api/messages
      todos.ts            — /api/rooms/:name/todos
      house.ts            — /api/house/*, /api/models, /api/tools
    ws-commands/          — WebSocket command handlers grouped by domain
      room-commands.ts    — create/delete/join/leave room, delivery mode, pause, mute
      agent-commands.ts   — spawn, remove, mute agent
      flow-commands.ts    — add/remove/start/cancel flow
      todo-commands.ts    — add/update/remove todo
      message-commands.ts — post message
  ui/
    index.html            — Browser UI (Tailwind CSS + marked + DOMPurify)
    modules/
      app.ts              — Application orchestrator
      ws-client.ts        — WebSocket client with reconnect
      ui-renderer.ts      — DOM rendering (messages, agents, rooms, flows, todos)
      modal.ts            — Modal dialogs
  main.ts                 — createSystem() factory + entry point
  bootstrap.ts            — Startup orchestration (snapshot, tools, MCP, server)
  index.ts                — Library exports

tools/                    — External filesystem tools (auto-loaded at startup)
  memory.ts               — think, note, my_notes, remember, recall, forget
  compute.ts              — calculate, json_extract, format_table
  web.ts                  — web_search, fetch_url
  research.ts             — arxiv_search, doi_lookup, semantic_scholar

docs/
  tools.md                — Full tool reference with parameters, usage, return values
```

---

## Persistence

State is auto-saved to `data/snapshot.json` after each message (debounced 5 seconds). On next startup, rooms, agents, message history, flows, todos, mute state, and delivery modes are all restored exactly as they were.

A graceful shutdown (`Ctrl+C`) drains any in-flight agent evaluations, then flushes the snapshot immediately.

The snapshot is a plain JSON file — readable, version-controlled, and portable. It carries a version number; the system validates it on load and will refuse to start if the snapshot is from a newer build, preventing silent data corruption.

**Note:** Active flow execution state (which step a flow is on) is not persisted. After a restart, rooms restore to broadcast mode and flows must be restarted manually.

---

## Development

```bash
bun run dev          # Start with hot-reload
bun test             # Full test suite (requires Ollama running)
bun run test:unit    # Unit tests only (no Ollama needed)
bun run check        # TypeScript type check
```

Tests cover: room logic, delivery modes, agent behaviour, tool execution, snapshot persistence, HTTP routes, WebSocket handler, MCP server, filesystem tool loader.

---

## Architecture Notes

**Everything is a factory function** — no classes, no `new`. Objects are created by factory functions and returned as typed interfaces.

**Single delivery path** — `routeMessage()` is the one function that routes messages. Rooms, DMs, and tools all call the same system functions. No parallel code paths.

**ID / name duality** — all entities have auto-generated UUIDs (internal) and human-readable names (LLM-facing). LLMs see and use names; the system resolves names to IDs at boundaries.

**Tool protocol** — agents using text-protocol models produce `::TOOL::` lines which are parsed and executed in a ReAct loop. Agents using native-capable models use structured tool calls. The `ToolCapabilityCache` detects capability once per model and caches the result. Tool results are truncated to 4,000 characters by default to prevent context overflow; this limit is configurable per agent via `maxToolResultChars` in `AIAgentConfig`.

**LLM context structure** — every agent evaluation assembles: house rules → room prompt → agent system prompt → skills (scope-matched behavioral templates) → auto-generated context (room, flow, participants, artifacts, tools) → response format → history (old + `[NEW]` tagged recent messages). The `context-builder.ts` is the single source of truth for what agents see.

**External tools** — the `loadExternalTools()` function scans `./tools/`, `~/.samsinn/tools/`, and `SAMSINN_TOOLS_DIR` for `.ts` files with a default Tool or Tool[] export. Loaded before snapshot restore so restored agents have access to them. Conflicts with built-in tool names are silently skipped.

**Agent memory** — two independent layers. Session memory is managed via a unified `AgentHistory` struct per agent: a `rooms` map (processed message history + room profile per room), a `dms` map (processed DMs per peer), and a shared `incoming` buffer of messages received since the last evaluation. When an agent evaluates a message — whether it responds or passes — the incoming buffer is flushed into the appropriate room or DM context. This flush-on-pass design means an agent never re-evaluates the same message twice. The `historyLimit` config caps how much history is sent to the LLM per evaluation (default 50 messages); the full history is preserved in memory indefinitely. Persistent memory is filesystem-based (via `memory.ts` tools) and survives restarts. The two layers are deliberately separate: session context is automatic; persistent facts are intentional.

**Tool descriptions** — every `Tool` can declare a `usage` field (when to use / when not to) and a `returns` field (what to expect back). These are injected into the agent's system prompt alongside the parameter schema, giving the LLM the guidance it needs to pick the right tool and interpret its output.

---

## Changelog

| Version | Changes |
|---|---|
| v0.6.0 | File-based skills system (Claude Skills compatible SKILL.md format with bundled tools); runtime code generation (`write_skill`, `write_tool`, `list_skills`); dynamic tool resolution (`refreshTools` — agents gain new tools without respawning); dedicated `=== SKILLS ===` prompt section; fix: `ToolContext.llm` now tracks current model instead of spawn-time model |
| v0.5.14 | Unified `AgentHistory` struct (rooms/DMs/incoming in one place); flush-on-pass (agents never re-evaluate passed messages); `ConcurrencyManager` extraction; snapshot migration framework; tool result truncation (4,000 char default, configurable); comprehensive file splitting (tools/built-in/, api/routes/, api/ws-commands/, mcp/tools/); config object consolidation; delivery-mode bug fix; graceful shutdown with eval drain |
| v0.5.13 | 19 built-in tools, 16 external tools (memory/compute/web/research), structured tool descriptions with usage/returns fields, filesystem tool loader, `delegate` tool with todo integration |
| v0.5.12 | Shared todo list per room: CRUD, WS sync, agent context injection, HTTP + MCP API |
| v0.5.11 | Delivery modes simplified to broadcast + flow; room pause; [[AgentName]] addressing; muting; Markdown rendering |
| v0.5.10 | MCP server (23 tools, 3 resources), headless stdio mode |
| v0.5.9 | Flows: ordered agent sequences with per-step prompts, loop support |
| v0.5.8 | Filesystem tool loader, external tool directories, conflict detection |
| v0.5.7 | Room prompt field in UI; onMessagePosted callback; room pause dots |

---

## License

MIT
