# Health-audit suppressions

Findings that the health audit should *not* re-surface as drift signals. Two
sections, two purposes:

1. `## known-noise` — entries that are intentional, documented, or pre-existing
   architectural choices. Static; only updated when CLAUDE.md or codebase
   conventions change.
2. `## deferred` — entries we considered, decided not to act on now, with a
   target revisit date or trigger condition. Can age out.

The `health-audit` skill reads this file before showing the user findings and
suppresses any entry that matches.

---

## known-noise

- **`createLLMGateway` alias of `createOllamaGateway` in `src/llm/gateway.ts`** — documented as an alias in CLAUDE.md ("createLLMGateway kept as alias"). Knip flags it as a duplicate export. Intentional.
- **Type-export-only "unused" findings under `src/core/types/*.ts`, `src/llm/*.ts` types, `src/ui/modules/stores.ts`** — these modules deliberately publish a wide type surface for future internal consumers and tooling. Pruning them risks breaking a downstream re-import we don't see at static analysis time. Re-evaluate only when a single type has been "unused" across multiple consecutive baselines AND no plan file references it.
- **`escape-hatches` count baseline = 64** — most are deliberate type-narrowing in transports (LLM streaming response shapes, tool-call accumulators). Increases above this baseline are real findings; decreases are wins worth committing.
- **`no-orphans` warnings on `src/integrations/mcp/tools/`, `src/tools/built-in/`, `src/api/routes/`, `src/api/ws-commands/`, `src/skills/`, `src/packs/`** — these are dynamic-loader entrypoints (registered at runtime) so they appear orphaned to static analysis. The dep-cruiser config already excludes them; if the count rises it means a new loader directory was added without updating `.dependency-cruiser.cjs`.
- **`tailwindcss` + `@tailwindcss/cli` "unused devDeps"** — false positive; both are invoked via `bunx @tailwindcss/cli` in package.json scripts. Suppressed in `knip.json` `ignoreDependencies`.
- **Test-fixture orphans under `src/tools/__fixtures__/`** — loaded dynamically by the tools-loader test. Suppressed in `knip.json` `ignore`.

## deferred

- **`zod` used as undeclared (transitive) dependency in 5 MCP tool files** (`src/integrations/mcp/tools/{agent,message,room,system,web}-tools.ts`). Comes via `@modelcontextprotocol/sdk`. Per CLAUDE.md "zero deps where possible" we should either (a) declare `zod` explicitly in package.json so the version is pinned, or (b) refactor the MCP tools to use plain JSON Schema (the same shape MCP-SDK tool registration accepts non-zod). **Trigger to revisit:** a zod major version bump in MCP SDK breaks tool registration silently. Decision is the user's; both fixes are ~30min.

- **`main.ts` at 1003 LOC** (crossed the 1000-LOC watch threshold called out in Phase 4 of the audit). Phase 0 audit-comments contributed ~25 LOC. Not a problem yet; documented because `bun run health` will surface it on every run. **Trigger to revisit:** main.ts crosses 1100 LOC, OR a self-contained subsystem (like `ollama-urls.ts` was) becomes extractable.

- **65 circular dependencies through `main.ts ↔ bootstrap.ts ↔ api/server.ts`** (deferred until 2026-09-01 or a related bug). These are real runtime cycles (verified with `tsPreCompilationDeps: false`). Likely artifact of `main.ts` being both the entrypoint AND the type-export hub for the System interface. Untangling is a structural refactor with non-trivial blast radius. **Trigger to revisit:** a real bug traced to circular import order, or a new entrypoint that needs to import from main.ts (forces the issue). Notes:
  - Most cycles route through `src/main.ts → src/bootstrap.ts → src/api/server.ts → src/api/http-routes.ts → src/api/routes/<route>.ts → src/main.ts` (route handlers re-import the System type from main.ts).
  - Possible cleanup direction: extract the System interface + late-bound callback types into a leaf module (e.g. `src/core/system-types.ts`) that nothing else imports. Routes import from there, main.ts imports from there. Cycle goes away.
  - Out of scope for current health work; documented here so the next reviewer doesn't re-investigate from scratch.
