# CLAUDE.md

Rules for working in this repo. Architecture overview is in [README.md](README.md); everything below is non-discoverable — invariants and tripwires you'd miss by reading the code.

## Version, workflow, commands

- **Version**: `package.json` is the single source of truth. Boot log, `/api/system/info`, UI footer, and bug-report modal all resolve it dynamically. When bumping, only edit `package.json` + README's top-line `> v0.X.Y` reference + the README changelog row + the git tag. Do NOT add hardcoded versions anywhere in `src/`. The dev server caches the version at first `/api/system/info` hit; restart after a bump.
- **Workflow**: commit each logical change as its own commit; push to master often. Branches/worktrees are fine if the CLI uses them; merge back before close.
- **Commands**:
  - `bun run check` — typecheck (always run after non-trivial edits)
  - `bun test` — full suite; `bun test -t '^(?!.*Ollama)'` skips Ollama integration (= `bun run test:unit`)
  - `bun test path/to/file.test.ts` — one file; `bun test -t "pattern"` filters by name
  - `bun run start` / `dev` / `headless` (MCP only) / `dev:remote` (`OLLAMA_URL=http://192.168.0.222:11434`)
  - `bun run health` — codebase audit (typecheck + type-coverage + escape-hatch grep + dep-cruiser + knip). Writes `.health/YYYY-MM-DD.md`. Pre-push hook runs a fast subset (`scripts/install-hooks.sh` to install).
- **Runtime**: Bun ≥1.0 required. Some code uses `Bun.serve`, `Bun.file`, `bun:test`; do not assume Node.

## Stable invariants (would not be obvious from reading the code)

- **One HTTP server** at `src/api/server.ts`, one MCP stdio server at `src/integrations/mcp/server.ts`. New routes go in `src/api/routes/`; new WS commands in `src/api/ws-commands/`. Never new servers.
- **`System.llm` is the `ProviderRouter`, always.** All agent spawn / eval / `callSystemLLM` calls go through `system.llm.chat(...)`. `System.ollama` is `LLMGateway | undefined` — present only when ollama is in the order; used by the Ollama dashboard UI.
- **Provider stack assembly canonically lives in `src/boot/provider-stack.ts`** — `buildProviderStack()` orders load → env-merge → providerKeys → setup → SharedRuntime. The four `src/llm/providers-*.ts` files are pieces; the assembly order matters and has bitten us three times (commits `d0c1f73` and successors).
- **Two delivery modes**: `broadcast` and `manual` (`src/core/rooms/delivery-modes.ts`). Plug new behavior into the mode switch; do not branch around it. Multi-agent orchestration belongs to the script engine, not the room.
- **Snapshot compatibility — clean break, no migrations.** `src/core/storage/snapshot.ts` rejects mismatched `SNAPSHOT_VERSION` outright and starts fresh. Bumping the version invalidates existing on-disk snapshots; that's the policy. Do not add migration shims.
- **Types import from the specific submodule** (`src/core/types/room.ts`, etc.), not a barrel.
- **Functional style only.** Factory functions + object literals + composition. No classes anywhere. No mocks/stubs/placeholder code — use real implementations.
- **Tests live next to source** (`foo.ts` + `foo.test.ts`).

## Rejected refactors (do not re-propose without significant new evidence)

These have been evaluated and rejected as motion-without-progress. Re-propose only if you can demonstrate a *significant* new benefit absent at the time of rejection — a bug traced to the pattern, a second-consumer use case, a measurable correctness/performance gain.

- **Replacing the `setOn*` late-bound callback slots in `main.ts`'s `createSystem` with an event bus.** The ~22 typed callback slots are intentional — parallel, independent, compile-time typed, localized. A `createEventBus<HouseEventMap>()` migration was evaluated: +33 net LOC, zero user-observable benefit, duplicated type information. YAGNI.

- **Extracting `createSystem` into 4 "boot phase" sub-functions.** Evaluated — spreads the slots across more files without eliminating them. If `main.ts` size is the problem, prefer targeted extractions of self-contained subsystems (as done for `ollama-urls.ts`, `ui-bootstrap-footer.ts`), not whole-factory splits.

- **MCP-vs-REST tool-surface "parity".** Different audiences, intentional divergence. REST/built-in is the agent-facing surface (in-process AI agent: `list_rooms`, `pass`, `geo_lookup`, `install_pack`, `write_skill`). MCP is the host-facing surface (external Claude Code: `create_agent`, `update_agent_persona`, `wait_for_idle`, `export_room`, `reset_system`). Each side has tools the other doesn't, by design.

- **Reviving the artifact / workspace system.** Removed in v18. Task lists, polls, documents, the workspace UI pane were torn out — agents handle the same workflows conversationally or via the script engine. Mermaid + map render inline as fenced code blocks. If a new workflow genuinely needs persistent shared objects (e.g. whiteboarding across many agents over time), name the specific second consumer and run it past the owner before scaffolding.

When in doubt: ugly ≠ broken. Move on.

## Anti-pattern tripwires (each has bitten this codebase)

- **No silent skips on optional dependencies.** `if (x) doX()` patterns hide latent bugs when `x` is sometimes-undefined due to ordering and invariants drift. Either: (a) annotate why "skip" is correct (`// evicted-during-event drop is intentional`), (b) assert `x` is present and throw, or (c) make `x` non-optional in the type. The bug fixed in `5d73a8e` (broadcast wiring silently skipped for cookie-bound instances) was three unannotated `if`s lined up.

- **Boot-once cache of derived state with external inputs.** The wiki bug fixed in `b660b3e`: `wikiRegistry.setWikis(merge(stored, discovered))` was called once at boot; CRUD endpoints re-synced but the GET handler didn't; `discovered` (GitHub org listing) changed externally → GET showed wikis the registry didn't know about. Lesson: if `X = compute(A, B)` is cached, invalidate when *either* input can change, or derive `X` fresh on each read (usually cheap). Pattern to watch: `setX(computeX())` at boot followed by reads that assume currency.

- **Silent fallbacks** (`catch {}`, `?? null`, `?? []`, early-return-on-undefined): require explicit justification of why the failure shouldn't be loud. Would a thrown error or a `warning` event surface this to an operator? If yes, prefer that. Documented further in `.health/suppressed.md` `## anti-patterns`.

- **Persistence captures the wrong abstraction.** For each new persisted field: if you rename or restructure the referenced concept later, will the persisted value still mean the right thing? If no, flag it. See `.health/suppressed.md`.

- **Silently-ANDed permission gates with no single error path.** Two gates returning the same "not available" with no way to tell which fired produced the 2026-05-12 tool-loop incident. Each new access-control gate's failure path must carry a structured reason.

- **Era-stale magic numbers.** `maxN: 10`, `timeoutMs: 5000` etc.: sized for current reality or copy-pasted from an older era? `historyLimit: 10` cutting off gpt-5.4 context (commit `1c0651e`) was the cost.

- **Cross-cutting concerns need end-to-end tests, not just unit tests.** When a feature touches >3 layers (e.g. eval → late-binding → wsManager → broadcastToInstance → WS → UI dispatch), one integration test of the full chain is worth more than five unit tests of layers. Unit tests of any single layer pass while the chain is broken. Existing examples: `src/api/broadcast-wiring.test.ts`, `src/llm/system-wiring.test.ts`.

## Plan reviews and stress-tests — extra checks for this repo

When running `claude-toolbox:stress-test` (or any plan review) on a plan touching this codebase, ADD these on top of the skill's default axes:

- **New fallback** the plan introduces (silent `catch {}`, `?? null` without recovery, early-return-on-undefined): require explicit justification (cross-reference "Silent fallbacks" above).
- **New persisted field**: snapshot-shape question (cross-reference "Persistence captures the wrong abstraction" above).
- **New access-control gate**: must have a structured failure reason distinguishing it from existing gates.
- **New magic number**: justified by current constraint or stale copy?

## Docs worth reading before non-trivial work

- [README.md](README.md) — user-facing feature surface, tool reference, REST + WS + MCP protocols
- [docs/tools.md](docs/tools.md) — tool authoring, parameter schemas, external tool loading
- [docs/scripts.md](docs/scripts.md) — multi-agent improv script engine (replaces macros)
- [docs/causality-tracking.md](docs/causality-tracking.md) — how message causality is recorded
