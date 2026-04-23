# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow: stay on master

**No branches. No worktrees. Work directly on `master` and push directly to `master`.**

The owner finds branching/worktree workflows more friction than they're worth for this single-maintainer repo. Pattern:

- Commit each logical change as its own commit with a clear message.
- `git push origin master` after each commit (or batch if a series of commits is logically one unit).
- If you find yourself about to create a branch "for safety", don't — commit smaller, more atomic units on master instead and push often.
- Exceptions require explicit request from the owner ("open a PR for X"). Default is: straight to master.

## Rejected refactors (do not re-propose)

These have been evaluated and rejected as motion-without-progress. Do NOT include them in audit reports, stress-tests, or improvement plans unless you can demonstrate a *significant* new benefit that wasn't present when they were rejected (e.g. a bug traced to the pattern, a second-consumer use case, a measurable performance or correctness gain).

- **Replacing `lateBinding` in `main.ts` with an event bus.** The 22 typed callback slots in `createSystem` (lines ~157–178) are intentional. They are parallel, independent, compile-time typed, and localized. A generic `createEventBus<HouseEventMap>()` migration was evaluated and produces +33 net LOC, zero user-observable benefit, and duplicated type information (System methods AND the event map). If you're tempted by "one source of truth for pub/sub" or "future `system.on('x', cb)` API", that's YAGNI — revisit only when a second consumer pattern actually emerges.

- **Extracting `createSystem` into 4 "boot phase" sub-functions.** Also evaluated — it just spreads the 22 `lateBinding` slots across more files without eliminating them. If `main.ts` size is the problem, prefer targeted extractions of self-contained subsystems (as was done for `ollama-urls.ts`), not whole-factory splits.

When in doubt: the `lateBinding` pattern is working. Ugly ≠ broken. Move on.

## Commands

- `bun run start` — run the server (HTTP + WebSocket + UI at :3000)
- `bun run dev` — same, with watch mode
- `bun run headless` — run as MCP server only (no HTTP UI); connects over stdio
- `bun run check` — typecheck (`tsc --noEmit`); always run after non-trivial edits
- `bun test` — run full suite. `bun test --filter '!Ollama'` skips Ollama integration tests
- `bun test path/to/file.test.ts` — run one file; `bun test -t "pattern"` filters by test name
- `bun run dev:remote` / `start:remote` — same as dev/start but with `OLLAMA_URL=http://192.168.0.222:11434`

Runtime is **Bun** (required ≥1.0). Do not assume Node — some code uses `Bun.serve`, `Bun.file`, `bun:test`.

## Architecture (big picture)

Samsinn is a multi-agent room-based chat system with three delivery modes and two front-doors (HTTP+WS browser UI, or MCP server).

### The one server rule

**Exactly one HTTP server exists at `src/api/server.ts`**, and one MCP (stdio) server at `src/integrations/mcp/server.ts`. Do not add new HTTP servers — integrate new endpoints into `src/api/routes/` or `src/api/ws-commands/`. See global rule in user CLAUDE.md.

### Core domain (`src/core/`)

- `house.ts` — the root singleton owning all rooms and agents; every request goes through it
- `room.ts` — membership, messages, mute/pause state; `room-macros.ts` holds macro orchestration state; `addressing.ts` resolves `[[AgentName]]` mentions
- `delivery.ts` + `delivery-modes.ts` — decides which agents receive each posted message (broadcast / macro / directed)
- `snapshot.ts` — persistence (load/save to `data/snapshot.json`). Bumping `SNAPSHOT_VERSION` requires a migration path
- `artifact-store.ts` + `artifact-type-registry.ts` + `artifact-types/*` — pluggable per-room artifacts (task-list, macro, document, poll, mermaid). New artifact types register themselves via the registry pattern
- `types/` — split into domain modules (`agent.ts`, `room.ts`, `artifact.ts`, `llm.ts`, `ws-protocol.ts`, etc). **Import from the specific submodule**, not a barrel

### Agents (`src/agents/`)

- `ai-agent.ts` + `human-agent.ts` implement the same `Agent` interface (factory functions, not classes — see global style rules)
- `context-builder.ts` assembles the prompt: system prompt + skills section + room context + todos + history summary + new-message buffer
- `evaluation.ts` parses agent output for `::TOOL::` calls and native tool-calls, runs the tool loop, produces the final message
- `concurrency.ts` enforces per-agent single-flight generation (one room at a time per agent)
- `spawn.ts` is the canonical factory — always create agents via spawn, never by hand

### LLM layer (`src/llm/`)

Multi-provider with failover. The shape is a layered stack:

- **`provider-gateway.ts`** — generic factory: semaphore + circuit breaker + metrics + event-driven health. Takes any `LLMProvider`. No Ollama-specifics. Used by every cloud provider.
- **`gateway.ts`** — `createOllamaGateway` composes the generic gateway plus Ollama extras (`loadModel` / `unloadModel`, ps-driven `loadedModels` poll, `keep_alive` injection). `createLLMGateway` kept as alias.
- **`ollama.ts`** — raw HTTP adapter for Ollama's native API.
- **`openai-compatible.ts`** — one HTTP adapter covering Groq / Cerebras / OpenRouter / Mistral / SambaNova (all speak OpenAI Chat Completions). Incremental tool-call accumulation in SSE streams; `<think>...</think>` extraction for DeepSeek R1-style content streams.
- **`errors.ts`** — typed discriminated errors: `OllamaError`, `GatewayError`, `CloudProviderError`. Use `isFallbackable(err)` to decide whether the router should fall through. `parseRetryAfterMs` handles both integer-seconds and HTTP-date formats.
- **`router.ts`** — `createProviderRouter({providers}, {order})` implements `LLMProvider`. Per-request failover with per-provider cooldown (driven by `Retry-After` when present). Soft preference by `(model → last-success provider)` stops ping-pong. Prefix-pinned models (`groq:llama-3.3-70b`) skip failover. Prefix split on **first colon only** — OpenRouter slugs contain colons. Emits `ProviderBoundEvent` / `ProviderAllFailedEvent` / `ProviderStreamFailedEvent` via `onRoutingEvent`.
- **`providers-config.ts`** — env parser → `ProviderConfig`. `PROVIDER=ollama` forces single-Ollama mode; `PROVIDER_ORDER` overrides priority; missing API keys dropped with a startup log line. Accepts an optional `fileStore: MergedProviders` to merge stored keys (env wins).
- **`providers-store.ts`** — file-backed provider config at `~/.samsinn/providers.json` (mode 0600). `loadProviderStore` / `saveProviderStore` (atomic write via temp+rename). `mergeWithEnv` resolves env-vs-stored precedence and returns per-provider `source: 'env' | 'stored' | 'none'`. Keys are never logged; `maskKey` produces `•••last4`.
- **`providers-setup.ts`** — builds gateways from config. Cloud gateways get `isPermanentError: isCloudProviderError` so fallbackable errors don't double-count against the router's cooldown map.
- **`tool-capability.ts`** — converts `Tool[]` → OpenAI-format `ToolDefinition[]`. Provider-neutral.

**`System.llm` is the ProviderRouter (always).** All agent spawn / eval / `callSystemLLM` goes through `system.llm.chat(...)`. **`System.ollama`** is `LLMGateway | undefined` — present only when Ollama is in the order; used by the Ollama dashboard UI for ps/loadModel.

Router routing events are wired to late-bound callbacks on `System` (see `setOnProviderBound` / `setOnProviderAllFailed` / `setOnProviderStreamFailed`). `ws-handler.ts` subscribes to those and broadcasts `provider_*` WS messages, which the UI dispatcher turns into toasts with 5 s dedup per (agentId, provider).

**Provider admin surface.** `GET/PUT /api/providers[/:name]` and `POST /api/providers/:name/test` live in `src/api/routes/providers.ts` — cross-provider config, never returns raw keys. `POST /api/system/shutdown` (in `src/api/routes/system.ts`) sends SIGTERM to the own process to trigger the existing graceful shutdown (snapshot flush + MCP disconnect); the supervisor is expected to respawn. UI panel is in `src/ui/modules/providers-panel.ts`, polls `/api/providers` every 10 s while the dialog is open.

### Tool + skill system

- Built-in tools: `src/tools/built-in/*` — hand-written, always loaded
- External tools: `.ts` files dropped in `./tools/` or `~/.samsinn/tools/`, discovered by `src/tools/loader.ts` at startup
- Skills: `~/.samsinn/skills/<name>/SKILL.md` (+ optional `tools/` subdir) loaded by `src/skills/loader.ts`. Agents can create skills at runtime via `write_skill` / `write_tool`
- All tools register into `src/core/tool-registry.ts`; agents see only the tool names listed in their config

### Front-end (`src/ui/modules/`)

Plain TypeScript, no framework. Nanostores for state (`stores.ts`), one WebSocket (`ws-client.ts`) dispatched by `ws-dispatch.ts`. Rendering is split into focused `render-*.ts` modules (agents, rooms, messages, thinking, mermaid). `app.ts` is the shell — do not put render logic there.

### MCP integration (`src/integrations/mcp/`)

Wraps the same `House` object for external LLMs. Tool handlers live in `tools/*-tools.ts`. Keep MCP tool surface in sync with the REST API — both are thin wrappers over `House`.

## Conventions specific to this repo

- **Functional style, no classes** — everything is factory functions + object literals (see global CLAUDE.md). Existing code is 100% this way; do not introduce classes
- **Tests live next to source** (`foo.ts` + `foo.test.ts`), not in a separate tree
- **No mocks / stubs / placeholder code** — see `memory/feedback_no_mocks.md`. Use real implementations or real test fixtures
- **File size** — recent refactors split files approaching 500+ lines. Keep new files focused; split when a file grows beyond industry norms
- **Snapshot compatibility** — changes to persisted shapes require bumping version + migration in `snapshot.ts`
- **Three delivery modes** — `broadcast`, `macro`, plus staleness-based (see `delivery-modes.ts`). Any new delivery behavior should plug into that switch, not branch around it

## Docs worth reading before non-trivial work

- `README.md` — user-facing feature surface, tool reference, REST + WS + MCP protocols
- `docs/tools.md` — tool authoring, parameter schemas, external tool loading
- `docs/artifact-modules.md` — how to add a new artifact type
- `docs/causality-tracking.md` — how message causality is recorded (affects macros, delegation)
