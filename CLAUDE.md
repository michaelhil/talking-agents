# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Version is sourced from package.json — never hardcode

`package.json` `version` is the single source of truth. Every runtime
reference resolves it dynamically:

- **Boot log** + **MCP server name** — [`src/bootstrap.ts:58`](src/bootstrap.ts:58)
  reads `package.json` once and passes the version to `createMCPServer`.
- **`/api/system/info`** — [`src/api/routes/system.ts`](src/api/routes/system.ts)
  reads + caches `package.json` on first request.
- **UI sidebar footer** ([`src/ui/modules/app.ts:793`](src/ui/modules/app.ts:793))
  and **bug-report modal context line** ([`src/ui/modules/bug-modal.ts:20`](src/ui/modules/bug-modal.ts:20))
  fetch from `/api/system/info`.

When bumping the version, **only edit `package.json`** + the README's
top-line `> v0.X.Y` reference + the README changelog row + the git tag.
Do NOT add a hardcoded version anywhere in `src/`.

A long-running dev server caches the version at first `/api/system/info`
hit; restart the server after a bump to see it reflected in the UI.

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
- `bun test` — run full suite. `bun test -t '^(?!.*Ollama)'` skips Ollama integration tests (equivalent: `bun run test:unit`)
- `bun test path/to/file.test.ts` — run one file; `bun test -t "pattern"` filters by test name
- `bun run dev:remote` / `start:remote` — same as dev/start but with `OLLAMA_URL=http://192.168.0.222:11434`

Runtime is **Bun** (required ≥1.0). Do not assume Node — some code uses `Bun.serve`, `Bun.file`, `bun:test`.

## Architecture (big picture)

Samsinn is a multi-agent room-based chat system with two delivery modes (`broadcast`, `manual`) and two front-doors (HTTP+WS browser UI, or MCP server). A **script engine** (see [docs/scripts.md](docs/scripts.md)) is being built to drive improvisational multi-agent scenes; it replaces the previous macro system.

### The one server rule

**Exactly one HTTP server exists at `src/api/server.ts`**, and one MCP (stdio) server at `src/integrations/mcp/server.ts`. Do not add new HTTP servers — integrate new endpoints into `src/api/routes/` or `src/api/ws-commands/`. See global rule in user CLAUDE.md.

### Core domain (`src/core/`)

- `house.ts` — the root singleton owning all rooms and agents; every request goes through it
- `room.ts` — membership, messages, mute/pause state; `addressing.ts` resolves `[[AgentName]]` mentions
- `delivery.ts` + `delivery-modes.ts` — decides which agents receive each posted message. Modes: `broadcast` (all eligible) and `manual` (humans + sender only; AI peers activated explicitly). `[[AgentName]]` / `[[tag:X]]` addressing overrides in all modes.
- `snapshot.ts` — persistence (load/save to `data/snapshot.json`). Current `SNAPSHOT_VERSION = 13`. Bumping is a clean break — no migration ladder
- `summary-engine.ts` + `summary-scheduler.ts` — per-room running summary + compression. Two independent schedules (time and message-count) per target (`summary` vs `compression`). Compression keeps last X fresh and folds older Y into a single evolving `room_summary` at the top of history; IDs tracked in `room.compressedIds`. Surfaced via 🗜 room-header control, `/api/rooms/:name/summary-config|summary|summary/regenerate`, and `summary_run_*` WS events. This replaced the earlier message-cap pruning and per-agent history compression
- `artifact-store.ts` + `artifact-type-registry.ts` + `artifact-types/*` — pluggable per-room artifacts (task-list, document, poll, mermaid). New artifact types register themselves via the registry pattern
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
- **Two delivery modes** — `broadcast` and `manual` (see `delivery-modes.ts`). Any new delivery behavior should plug into the mode switch, not branch around it. Multi-agent orchestration (improv scenes) is the script engine's concern, not the room's.
- **No silent skips on optional dependencies.** `if (x) doX()` patterns hide latent bugs when `x` is sometimes-undefined due to ordering and the codebase's invariants drift. Either: (a) add a one-line comment explaining why "skip" is correct semantics (e.g. `// evicted-during-event drop is intentional`), or (b) assert `x` is present and throw when it isn't, or (c) use the type system to make `x` non-optional. The bug fixed in `5d73a8e` (broadcast wiring silently skipped for cookie-bound instances) was three layers of unannotated `if`s lined up. Reviewers look for the pattern; future-you greps for it when bug-hunting.
- **Cross-cutting concerns get end-to-end tests, not just unit tests.** Streaming, snapshot save/restore, instance reset, cookie/auth flow, pack install propagation. When a feature touches >3 layers (e.g. eval → late-binding → wsManager → broadcastToInstance → WS → UI dispatch), one integration test that exercises the full chain is worth more than five unit tests of individual layers. Unit tests of any single layer pass while the chain is broken; the integration test is what catches the disconnected wire. Existing examples: `src/api/streaming.test.ts`, `src/llm/system-wiring.test.ts`.
- **Beware "boot-once cache of derived state with external inputs."** The wiki bug fixed in commit `b660b3e` (followed by the `resolveActiveWikis` refactor) had this exact shape: `wikiRegistry.setWikis(merge(stored, discovered))` was called once at boot. The CRUD endpoints re-synced, but the GET handler didn't — and `discovered` (GitHub org listing) could change without any local action. Result: GET showed wikis the registry didn't know about; refresh 404'd. Lesson: if `X = compute(A, B)` is cached, ensure the cache is invalidated whenever `A` or `B` can change, regardless of which trigger fires. Better yet, derive `X` fresh on each read (compute is usually cheap; one disk + one cached fetch). The pattern to watch for is: `setX(computeX())` at boot followed by reads that assume `X` is current. The packs/tools/skills registries don't have this risk because their inputs are local-write-through; only wiki had the external (GitHub) input + boot-time freeze combo. Audit any new "registry" subsystem against this pattern before merge.

## Docs worth reading before non-trivial work

- `README.md` — user-facing feature surface, tool reference, REST + WS + MCP protocols
- `docs/tools.md` — tool authoring, parameter schemas, external tool loading
- `docs/artifact-modules.md` — how to add a new artifact type
- `docs/scripts.md` — multi-agent improv script engine (replaces macros)
- `docs/causality-tracking.md` — how message causality is recorded
