# Samsinn

**A multi-agent collaboration system.** Spawn AI agents, put them in rooms, let them think together — or orchestrate them programmatically through the REST API, WebSocket protocol, or as an MCP server. Run as a personal sandbox locally, or self-host on a small VPS with one isolated *instance* per user.

> v0.9.2 — [Changelog](#changelog) · [Deploy runbook](deploy/RUNBOOK.md)

---

## What you can do with it

- **Run a panel of AI specialists** — a Researcher, Analyst, and Writer in the same room, bouncing ideas off each other and you
- **Track tasks collaboratively** — agents and humans share a todo list per room; agents complete todos and record results
- **Give agents tools** — agents can search the web, do math, remember facts across sessions, delegate subtasks, manage rooms, and query each other
- **Self-extending agents** — agents create Skills (behavioral templates) and write new tools at runtime, making the system grow its own capabilities
- **Embed in your own LLM workflow** — run headless as an MCP server; external LLMs orchestrate everything via 23 tools
- **Integrate programmatically** — full REST API + WebSocket protocol for building your own UI or automation
- **Self-host with multi-instance isolation** — one Bun process serves many independent sandboxes, each cookie-bound to its own user. Manage them from Settings → Instances (list, switch, create, delete, reset). See [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) for the Hetzner CAX11 (~€4/mo) deploy path.

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

Open **http://localhost:3000** in your browser, enter your name, and you're in.

**New to Samsinn?** See **[docs/getting-started.md](docs/getting-started.md)** — a 20-minute walkthrough that tours the UI and runs you through two missions (two-agent debate → shared todo list). Start there if you want to *use* Samsinn; keep reading here if you want the full reference.

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.0 | Runtime and package manager |
| [Ollama](https://ollama.ai) | optional | Runs AI models locally; remote via `OLLAMA_URL` |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | optional | OpenAI-compatible local server; URL via `LLAMACPP_BASE_URL` (default `http://localhost:8080`). Run with `llama-server -m model.gguf -ngl -1 -c 8192 -np 2 --port 8080`. No API key required by default; pass `--api-key <key>` to llama-server and set `LLAMACPP_API_KEY` to require auth. `cache_prompt: true` is llama.cpp's default — repeated room context reuses the KV cache automatically. Tool-using agents may fail depending on the model + llama-server build (the chat template must support tool calls); the failure surfaces as a meaningful error toast. |

Cloud providers (Anthropic, Gemini, Groq, Cerebras, OpenRouter, Mistral, SambaNova) are also supported via API keys configurable in Settings → Providers and stored at `$SAMSINN_HOME/providers.json` (mode 0600). Ollama-only is fine — keys are optional and never required to start.

---

## Core Concepts

### Rooms

A room is a shared conversation space. Agents must be explicitly added to a room. Messages are stored and history is preserved across restarts (auto-saved snapshot).

Each room has:
- A **name** and optional **room prompt** (instructions all agents in the room receive in their context)
- An explicit **member list**
- A **delivery mode** (`broadcast` or `manual`)
- A **shared todo list**

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
| **Manual** | Humans only — AI peers are skipped; each AI is activated explicitly via a ▶ button on its chip |

**Directed addressing** — write `[[AgentName]]` anywhere in a message to override the mode and deliver only to that agent. Inert in manual mode (only the explicit ▶ click fires an agent).

**Manual turn-taking** — switching a room into `manual` cancels any in-flight AI generation in that room, then holds every subsequent message until the user clicks ▶ on a specific AI chip. The activated agent catches up on any messages it missed and takes exactly one turn. Humans can post as many messages as they like between activations.

**Muting** — mute any agent in any room from the UI. Muted agents are excluded from delivery in that room only.

**Pause** — pause a room to halt all delivery temporarily (useful while re-configuring it).

### Scripts (in development)

Multi-agent improvisational scenes — characters with private wants, structural resolution, no central judge. See [docs/scripts.md](docs/scripts.md) for the design. Replaces the previous macro system.

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

### Room Summary & Compression

Every room has an evolving **summary** (running description of the conversation) and a **compression** mechanism that keeps context windows bounded as the room grows. Both are per-room, configurable, and streamed live.

**Summary** — an LLM-generated running description of the room. Re-runs on a configurable schedule (time interval *or* message count), or on demand via the 🗜 room-header control. Aggressiveness is `low` / `medium` / `high`. An optional model override can be set per room.

**Compression** — keeps the last `X` messages fresh. Once the uncompressed tail reaches `X + Y`, the oldest `Y` messages are folded into a single evolving `room_summary` at the top of the history and their IDs are tracked in `compressedIds`. The previous summary is replaced, not chained. Agents see this as `[Room Summary]` at the top of their room context via `context-builder.ts`.

- **UI** — the 🗜 button in the room header reveals `⚙` (config), `🔍` (inspect with live deltas), `↻` (regenerate). First open auto-generates if no output exists.
- **REST** — `GET/PUT /api/rooms/:name/summary-config`, `GET /api/rooms/:name/summary`, `POST /api/rooms/:name/summary/regenerate` (body: `{ target: 'summary' | 'compression' | 'both' }`).
- **WebSocket** — `set_summary_config`, `regenerate_summary`; lifecycle events `summary_run_started` / `summary_run_delta` / `summary_run_completed` / `summary_run_failed`.
- **Snapshot** — persisted as part of `SNAPSHOT_VERSION = 11`.

This feature replaces the earlier message-cap pruning and per-agent history compression, which were removed in the same change.

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
allowed-tools: [web_search, read_file]
---

When analyzing data, follow these steps:
1. Identify the data source
2. Formulate queries using available tools
3. Summarize findings with citations
```

Skills are loaded at startup and injected into agent context as a dedicated `=== SKILLS ===` section. Scope controls which rooms see which skills — empty scope means global.

**`allowed-tools` frontmatter** (Anthropic-Skills compatibility) — parsed and preserved on the loaded skill as `Skill.allowedToolNames`, surfaced in the skill detail endpoint. **Metadata-only in the current pass**: Samsinn does NOT auto-inject these tools into an agent's tool set (agent tools remain driven by `AIAgentConfig.tools`). Unknown names emit one dedup'd startup warning per skill. Inline array (`[a, b]`), block list (`- a\n- b`), and single-scalar forms are all accepted. Pack-namespaced resolution is not yet implemented — names resolve against the global registry.

**Runtime skill creation** — agents can create new skills (`write_skill`) and bundle tools with them (`write_tool`) at runtime. Generated skills persist as files and survive restarts.

### Packs

A **pack** is a GitHub-hosted bundle of domain-specific skills and tools installed with one command — `install_pack vatsim` resolves the bare name against the configured registry and pulls the matching repo. Effective immediately; no restart needed.

Packs namespace their contents from `pack.json`'s `name` field: a tool named `plan` inside the `vatsim` pack registers as `vatsim_plan`; the same-named tool inside `driving` becomes `driving_plan`. They coexist, and neither shadows a built-in `plan`. Skills get `<pack>/<name>` keys (`vatsim/atc-controller`).

Three ways to install:
- `install_pack vatsim`                  → resolved via the registry (call `list_available_packs` to browse)
- `install_pack alice/my-pack`           → `github.com/alice/my-pack`
- `install_pack https://github.com/...`   → any full URL (https/ssh/git/file://)

From the UI, **Settings → Packs** has an **Available** browse list (one-click install) and an **Installed** list with update/uninstall buttons. See [docs/packs.md](docs/packs.md) for the naming convention, authoring layout, and the registry env var (`SAMSINN_PACK_SOURCES`). Pack management is gated by `SAMSINN_ENABLE_PACKS` (default on).

### Wikis (vetted knowledge)

Bind GitHub-hosted [`llm-wiki-skills`](https://github.com/michaelhil/llm-wiki-skills) wikis (e.g. `nuclear-wiki`, `ai-human-factors-wiki`) to a room so agents can ground answers on vetted content via `wiki_search` / `wiki_get_page`. Configured under **Settings → Wikis**. See [docs/wikis.md](docs/wikis.md) for setup, multi-account PAT, and REST surface.

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

Click the **mode selector** (top of the room panel) to switch between broadcast and manual.

Each agent chip in the room header shows a status dot (green = idle, yellow = generating, grey = muted). Click the dot to toggle mute in that room. Hover the chip for the **×** to remove from the room. Use the **⏸** in the room panel to pause the room.

**Manual mode** adds a ▶ button to every AI agent chip. Clicking ▶ gives that agent exactly one turn with the current room state. Muted agents' ▶ is hidden.

**Bookmarks** — the 🔖 toolbar button opens a system-wide bookmark list. Hover any message to see its own 🔖 icon; click to add the message text to the list. Rows support in-line edit (pen) and delete (×). Clicking a row sends the text to the current room as a human message.

The sidebar agent list has a hover-reveal **×** on each row for deleting the agent entirely.

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

†`web_search` requires one of `TAVILY_API_KEY` (default — LLM-optimized, free 1000/mo at [tavily.com](https://app.tavily.com/)), `BRAVE_API_KEY`, or `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_ID`. Precedence is Tavily → Brave → Google CSE.

---

## Configuration

All configuration is via environment variables. No config file is required.

### Core

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `PORT` | `3000` | HTTP/WebSocket port |
| `TAVILY_API_KEY` | — | Enables `web_search` via Tavily (default — LLM-optimized, free 1000/mo) |
| `BRAVE_API_KEY` | — | Enables `web_search` via Brave (used if Tavily not set) |
| `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_ID` | — | Enables `web_search` via Google CSE (used if Tavily and Brave not set) |
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
| `LLAMACPP_BASE_URL` | `http://localhost:8080` | URL of a `llama-server` instance. No key required by default. |
| `LLAMACPP_API_KEY` | — | Set if `llama-server` was launched with `--api-key`. |
| `<NAME>_MAX_CONCURRENT` | 2 (Cerebras), 3 (Groq), 1 (OpenRouter), 2 (Mistral/SambaNova), 1 (llama.cpp) | Max concurrent requests per provider |
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

**Messaging:** `post_message`, `get_room_messages`, `wait_for_idle`, `export_room`

**Membership:** `add_to_room`, `remove_from_room`

**Delivery control:** `set_delivery_mode`, `set_paused`, `set_muted`

**Todos:** `list_todos`, `add_todo`, `update_todo`

**House config:** `get_house_prompts`, `set_house_prompts`

**Resources:** `samsinn://rooms`, `samsinn://agents`, `samsinn://rooms/{name}/messages`

---

## Scripted runs

Four primitives for scripting reproducible runs — the building blocks for a future batch-experiment runner (Phase 2). Each is usable today from the MCP stdio interface or the REST API.

### Deterministic seed

`AIAgentConfig.seed` (optional integer) is forwarded to every LLM call the agent issues, including tool-initiated sub-calls via `ToolContext.llm`. Surfaced on the `create_agent` MCP tool.

| Provider | Seed honored |
|---|---|
| Ollama | ✅ (via `options.seed`) |
| OpenAI | ✅ |
| Groq | ✅ |
| Cerebras | ✅ |
| OpenRouter | ✅ (depends on upstream model) |
| Mistral | ✅ |
| SambaNova | ✅ |
| Anthropic | ❌ silently discarded |
| Gemini | ❌ silently discarded |

Seed + high temperature still produces varied output (provider-dependent). For maximal reproducibility set `seed` and `temperature: 0`.

### `wait_for_idle` MCP tool

Blocks until a room has been quiet for `quietMs` (default 5000) AND every in-room AI agent has resolved `whenIdle()`, or `timeoutMs` (default 120000) elapses. Combining the two signals prevents false-idle during long thinking or long tool loops.

```
wait_for_idle({roomName: "trial-1", quietMs: 5000, timeoutMs: 60000})
→ {idle: true, messageCount: 14, lastMessageAt: 1745...,  elapsedMs: 5100}
```

### Full conversation export

`export_room` MCP tool **and** `GET /api/rooms/:name/export` return the same JSON: every message in the room with all telemetry it carries (tokens, provider, model, `generationMs`). Messages pass through unchanged — any future field on `Message` flows into exports automatically.

```
$ curl http://localhost:3000/api/rooms/trial-1/export | jq '.messageCount'
14
```

Tool-call traces are not included (tool calls are internal to the evaluation loop, not persisted on messages).

### Ephemeral mode

`SAMSINN_EPHEMERAL=1` disables all snapshot I/O — no load at boot, no per-change auto-save, no shutdown flush. Every run starts clean and leaves no trace on disk. Intended for batch runs where each invocation should be independent.

```bash
SAMSINN_EPHEMERAL=1 bun run headless
```

Startup prints `[bootstrap] ephemeral mode — snapshot disabled` as confirmation.

### What's not here yet (Phase 2)

The runner itself — spec-file loader, variant orchestrator, result aggregator — is not included. The four primitives above are the vocabulary the runner will compose from. Expected to live in a sibling `experiments/` folder that drives a samsinn subprocess over MCP stdio.

---

## Observational logging

For research on **live** sessions (control-room studies, usage audits, retrospective analysis of operator ↔ agent interactions), samsinn can write an append-only JSONL event stream capturing everything significant: messages with full telemetry and tool-call traces, room lifecycle, agent evaluation events, provider routing, artifact changes, summaries.

Opt in at boot via `SAMSINN_LOG_ENABLED=1`, or at runtime via `PUT /api/logging` or the `configure_logging` MCP tool — no restart needed. Change session id, directory, or kind filter live.

```bash
curl -X PUT http://localhost:3000/api/logging \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"sessionId":"shift-morning-1"}'
```

See [`docs/logging.md`](docs/logging.md) for full schema, jq/pandas/DuckDB analysis examples, privacy guidance, and deployment notes.

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
  core/                   — House, Room, Team, snapshot, registry, paths, artifacts
  agents/                 — AI + human agents, spawn, evaluation, history, concurrency
  llm/                    — ProviderRouter, gateways (Ollama + OpenAI-compat cloud), errors
  tools/                  — Built-in tools + filesystem loader for drop-ins
  skills/                 — SKILL.md loader, packs
  integrations/mcp/       — MCP client (consume) + MCP server (expose 37+ tools)
  api/                    — Bun.serve, REST routes, WS handler, instance cookie, rate limiter
  logging/                — JSONL sink with 2-file rotation
  ui/                     — Browser UI: index.html + modules/*.ts (manual DOM, nanostores)
  main.ts                 — createSystem() factory
  bootstrap.ts            — Startup: shared runtime, registry, janitor, server

tools/                    — External drop-in tools (auto-loaded at startup)
deploy/                   — Caddyfile, samsinn.service, RUNBOOK.md
docs/                     — User docs (tools, packs, logging, artifacts, getting-started)
notes/research/           — Design exploration & research notes (not user-facing)
```

`bun run check` and `find src -type f -name '*.ts'` are the source of truth — this tree is intentionally high-level so it doesn't drift.

---

## Multi-instance ("sandboxes")

Samsinn supports many independent *instances* in one Bun process. Each instance has its own rooms, agents, message history, todos, snapshot, and per-instance log directory. Instances share only the LLM provider gateways (one ProviderRouter, one Ollama gateway), provider keys, packs, and skills — i.e. things that are expensive to build and shouldn't be duplicated.

**How a request is bound to an instance.** A signed `samsinn_instance` HttpOnly cookie carries a 16-character id. First-time visitors get a fresh id auto-assigned; subsequent requests reuse it. `?join=<id>` on any URL switches the cookie and 303-redirects to a clean URL — that's how you share an instance.

**Layout on disk** (override the root with `SAMSINN_HOME`):

```
$SAMSINN_HOME/                              ← default ~/.samsinn (dev) or /var/lib/samsinn (deploy)
  providers.json                            ← provider keys (shared across instances)
  packs/<namespace>/                        ← shared packs
  skills/<name>/                            ← shared skills
  tools/                                    ← shared drop-in tools
  instances/
    <id>/
      snapshot.json                         ← per-instance state
      logs/*.jsonl                          ← per-instance logging (2-file ring, 50 MB each)
      memory/<agentName>/{notes.log,facts.json}
    .trash/<id>-<unix-ts>/                  ← evicted/reset, purged after 7 days
```

**The Instances modal** (Settings → Instances) lets you list every sandbox on disk, switch between them, create new ones, reset the current one (10-second cancellable countdown), and bulk-delete others. The current instance has a "Reset" action; non-current rows have "Switch" / "Delete". Click the header `Delete` button to enter bulk-delete mode (checkboxes appear pre-checked).

**Lifecycle.** Idle instances are evicted from memory after `SAMSINN_IDLE_MS` (default 30 min): drained, snapshot-flushed, dropped. The next request lazy-reloads from disk. The `instance-cleanup` janitor demotes long-idle directories to `.trash/` and purges trash after `SAMSINN_TRASH_TTL_MS` (default 7 days). Per-instance reset (`/api/system/reset`) trashes the directory but preserves the cookie's id, so the user reconnects to a fresh empty House under the same id.

**Resource caps and rate limits.** A per-IP sliding-window limiter (5 requests / 60 s, env-tunable) covers `POST /api/instances` and `POST /api/bugs`. Log files rotate at `SAMSINN_LOG_MAX_BYTES` (default 50 MB) into a 2-file ring (`<base>.jsonl` + `<base>.1.jsonl`) — per-instance footprint capped at 100 MB.

**Bug reporting.** Settings → Report bug (or the bug icon in the room header) opens a form that submits to `POST /api/bugs`. The server uses `SAMSINN_GH_TOKEN` to create a GitHub issue on `SAMSINN_GH_REPO` (default `michaelhil/samsinn`). Disabled if the token is unset. The browser never sees the token; submissions include only the user-typed title/description plus app version + browser UA.

For full deployment instructions (Hetzner CAX11, systemd unit, Caddy reverse proxy, `/etc/samsinn/env`, backup pattern, day-2 ops) see [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md).

---

## Persistence

State is auto-saved to `$SAMSINN_HOME/instances/<id>/snapshot.json` after each message (debounced 5 seconds). On next startup, rooms, agents, message history, todos, mute state, and delivery modes are all restored exactly as they were.

A graceful shutdown (`Ctrl+C`) drains any in-flight agent evaluations, then flushes the snapshot immediately.

The snapshot is a plain JSON file — readable, version-controlled, and portable. It carries a version number; the system validates it on load and will refuse to start if the snapshot is from a newer build, preventing silent data corruption.

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

**LLM context structure** — every agent evaluation assembles: house rules → room prompt → agent system prompt → skills (scope-matched behavioral templates) → auto-generated context (room, participants, artifacts, tools) → response format → history (old + `[NEW]` tagged recent messages). The `context-builder.ts` is the single source of truth for what agents see.

**External tools** — the `loadExternalTools()` function scans `./tools/`, `~/.samsinn/tools/`, and `SAMSINN_TOOLS_DIR` for `.ts` files with a default Tool or Tool[] export. Loaded before snapshot restore so restored agents have access to them. Conflicts with built-in tool names are silently skipped.

**Agent memory** — two independent layers. Session memory is managed via a unified `AgentHistory` struct per agent: a `rooms` map (processed message history + room profile per room), a `dms` map (processed DMs per peer), and a shared `incoming` buffer of messages received since the last evaluation. When an agent evaluates a message — whether it responds or passes — the incoming buffer is flushed into the appropriate room or DM context. This flush-on-pass design means an agent never re-evaluates the same message twice. The `historyLimit` config caps how much history is sent to the LLM per evaluation (default 50 messages); the full history is preserved in memory indefinitely. Persistent memory is filesystem-based (via `memory.ts` tools) and survives restarts. The two layers are deliberately separate: session context is automatic; persistent facts are intentional.

**Tool descriptions** — every `Tool` can declare a `usage` field (when to use / when not to) and a `returns` field (what to expect back). These are injected into the agent's system prompt alongside the parameter schema, giving the LLM the guidance it needs to pick the right tool and interpret its output.

---

## Changelog

| Version | Changes |
|---|---|
| v0.9.2 | **WS hardening sweep.** Closed the backpressure consistency gap left by v0.9.1 — command-handler responses (post_message, activation_result, artifact_created, all error paths) now route through `wsManager.safeSend` so the 8 MB cap covers ~50% more send traffic. `buildSnapshot` no longer fabricates an empty shell when the instance is evicted between WS upgrade and snapshot build — closes the socket with custom code 4001 ("instance unavailable") instead, client reconnects honestly. New TTL sweep (hourly) drops sessions whose WS has been closed >7d AND removes the inactive human agent — bounds the only previously-unbounded WS map; counted via `staleSessionsEvicted`. UI exponential reconnect backoff (1/2/4/8/16/30s, reset on onopen) replaces the fixed 2s retry. Dropped the `ollama_metrics` WS push entirely — dashboard now polls `GET /api/ollama/metrics` every 3s while open; net deletion + the WSInbound discriminated union becomes truly exhaustive (no more untyped escape hatch). |
| v0.9.1 | **Caps & limits hardening.** Bound WS send queue per client (8 MB) — slow consumers are closed with 1009 instead of growing memory unbounded; reconnect path is unchanged. Replaced rate-limit GC sweep with a true LRU bound (4096 keys) — defends direct-exposure deploys from unique-IP map exhaustion. New `LimitMetrics` counter object on `SharedRuntime` tracks `sseBufferExceeded`, `evictionFlushRetries`, `evictionForceEvicts`, `wsBackpressureDropped`, `rateLimitEvicted` — surfaced via auth-gated `GET /api/system/limits`. Documented LRU bypass limitation (acceptable behind Caddy). |
| v0.9.0 | **Script engine v2 + audit hardening.** Scripts are now markdown-source (`$SAMSINN_HOME/scripts/<name>/script.md`); reactive runner subscribed to `onMessagePosted`; two-LLM whisper classification; context-builder bypass for cast members; settings modal + room-header start/status chip; `write_script` tool. Safety: per-tick liveness check (auto-abort if cast leaves room); whisper consecutive-failure circuit breaker (5 fallbacks → stop with stage card); 256 KB cap on script source. **LLM hardening**: bounded SSE re-assembly buffer (10 MB); `Retry-After` past dates → undefined (was 0, collapsed cooldown); Ollama `toolChoice` warning surfaced once-per-pair (was silently dropped); `/api/providers/:name/test-model` truncates upstream 5xx body to 500 chars. **Persistence**: incompatible snapshot version logs at error (was warn); eviction flush retries 5/15/60s before force-evict with ERROR; per-type `validateBody` drops corrupt artifact bodies on snapshot load instead of crashing rehydrate. **Security**: regression test for global auth gate (covers shutdown + providers); defense-in-depth `assertValidInstanceId` inside `instancePaths()`/`trashPath()`. Snapshot v13. |
| v0.8.0 | **Scripts replace macros** — improvisational multi-agent scenes driven by per-character objectives, structural resolution (no central judge), and a `update_beat` speech-act bus. Filesystem-backed scripts at `$SAMSINN_HOME/scripts/<name>/script.json` (or flat `<name>.json`); `LLMRequest.toolChoice` plumbed through OpenAI-compatible providers; new REST under `/api/scripts` and `/api/rooms/:name/script/{start,stop}`; new WS events `script_started`, `script_scene_advanced`, `script_beat`, `script_completed`. Snapshot v11 → v12 (clean break — old snapshots with macros are rejected). See [docs/scripts.md](docs/scripts.md). |
| v0.7.0 | **Multi-instance** — one Bun process serves many cookie-bound sandboxes; `$SAMSINN_HOME/instances/<id>/`, lazy load + idle eviction + janitor + 7-day trash purge; per-instance reset replaces whole-process exit. **Instances UI** under Settings (list / switch / create / delete + bulk delete + reset). **Room switcher** dropdown next to room name. **Visibility popover** — eye icon hides/shows room-header buttons (localStorage), doubles as a quick-access bar. **Bug reporting** to GitHub Issues via server-side PAT (`SAMSINN_GH_TOKEN`). **Deploy mode** — `SAMSINN_AUTH_TOKEN` shared-token auth, systemd unit + Caddyfile + Hetzner CAX11 RUNBOOK. HTTP security headers, per-IP rate limiter, log rotation 2-file ring (env-tunable). |
| v0.6.0 | File-based skills system (Claude Skills compatible SKILL.md format with bundled tools); runtime code generation (`write_skill`, `write_tool`, `list_skills`); dynamic tool resolution (`refreshTools` — agents gain new tools without respawning); dedicated `=== SKILLS ===` prompt section; fix: `ToolContext.llm` now tracks current model instead of spawn-time model |
| v0.5.14 | Unified `AgentHistory` struct (rooms/DMs/incoming in one place); flush-on-pass (agents never re-evaluate passed messages); `ConcurrencyManager` extraction; snapshot migration framework; tool result truncation (4,000 char default, configurable); comprehensive file splitting (tools/built-in/, api/routes/, api/ws-commands/, mcp/tools/); config object consolidation; delivery-mode bug fix; graceful shutdown with eval drain |
| v0.5.13 | 19 built-in tools, 16 external tools (memory/compute/web/research), structured tool descriptions with usage/returns fields, filesystem tool loader, `delegate` tool with todo integration |
| v0.5.12 | Shared todo list per room: CRUD, WS sync, agent context injection, HTTP + MCP API |
| v0.5.11 | Delivery modes simplified to broadcast + macro; room pause; [[AgentName]] addressing; muting; Markdown rendering |
| v0.5.10 | MCP server (23 tools, 3 resources), headless stdio mode |
| v0.5.9 | Macros: ordered agent sequences with per-step prompts, loop support |
| v0.5.8 | Filesystem tool loader, external tool directories, conflict detection |
| v0.5.7 | Room prompt field in UI; onMessagePosted callback; room pause dots |

---

## Security posture

Samsinn supports two operating modes:

**Personal mode (default).** No `SAMSINN_AUTH_TOKEN` set. Any client that can reach the port has full access — bind to `localhost` only. Treat it like a dev server.

**Deploy mode.** `SAMSINN_AUTH_TOKEN` set in `/etc/samsinn/env`. The HTTP + WebSocket surface requires a session cookie issued by `POST /api/auth` against the shared token. The systemd unit + Caddyfile in `deploy/` set this up; see [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md).

**Shared by both modes:**

- Provider API keys live in `$SAMSINN_HOME/providers.json` (mode 0600) and are never returned raw via the admin endpoints. The `maskKey` helper keeps them out of logs and network responses.
- `GET /api/tools/:name` serves raw TypeScript source for external / skill-bundled tools, but only when the request originates from loopback (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`). On a non-loopback bind the source field is omitted.
- Bun.serve sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` on every response. The Caddyfile in `deploy/` adds CSP + HSTS on top.
- Instance creation and bug submission share a per-IP sliding-window rate limiter (5 / 60 s, env-tunable via `SAMSINN_CREATE_RATE_LIMIT` / `SAMSINN_CREATE_RATE_WINDOW_MS`).
- The `samsinn_instance` cookie is HttpOnly, SameSite=Lax, and Secure when behind an HTTPS proxy (`X-Forwarded-Proto: https`) or `SAMSINN_SECURE_COOKIES=1`.
- Bug reports never include conversation content. Auto-attached context is limited to app version + browser UA.

## License

MIT
