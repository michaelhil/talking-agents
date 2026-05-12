# Health-audit suppressions

Findings that the health audit should *not* re-surface as drift signals. Three
sections, three purposes:

1. `## known-noise` — entries that are intentional, documented, or pre-existing
   architectural choices. Static; only updated when CLAUDE.md or codebase
   conventions change.
2. `## deferred` — entries we considered, decided not to act on now, with a
   target revisit date or trigger condition. Can age out.
3. `## anti-patterns` — named failure-mode patterns we've been bitten by, with
   how to detect them and known false-positive call sites. Companion to
   CLAUDE.md `## Rejected refactors`: that section records decisions not to
   refactor; this section records patterns to scan for actively. Each entry
   may carry both a description (so a human can recognise it in review) and
   a grep counter check function in `scripts/health.sh` (so the periodic
   audit surfaces drift). New patterns are added when we discover them
   through debugging — see the meta-note at the end of that section.

The `health-audit` skill reads this file before showing the user findings and
suppresses any entry that matches.

---

## known-noise

- **`createLLMGateway` alias of `createOllamaGateway` in `src/llm/gateway.ts`** — documented as an alias in CLAUDE.md ("createLLMGateway kept as alias"). Knip flags it as a duplicate export. Intentional.
- **Type-export-only "unused" findings under `src/core/types/*.ts`, `src/llm/*.ts` types, `src/ui/modules/stores.ts`** — these modules deliberately publish a wide type surface for future internal consumers and tooling. Pruning them risks breaking a downstream re-import we don't see at static analysis time. Re-evaluate only when a single type has been "unused" across multiple consecutive baselines AND no plan file references it.

- **Aggregator re-exports flagged as unused** — modules like `src/tools/built-in/index.ts`, `src/tool-surface/index.ts`, `src/biometrics/index.ts`, `src/ui/modules/mermaid/index.ts`, `src/ui/modules/map/index.ts` re-export named symbols as their public API surface. Knip flags re-exports whose downstream consumers are intra-module or side-effect imports — false positive for the project's "index.ts is the public surface" convention. Decreases in the unused-export count are wins (real cleanup); increases get audited individually before adding to this list. Also includes module-level top-level registrations consumed by side-effect import (e.g. `renderMermaidBlocks` self-registers via `addPostRenderProcessor`).
- **`escape-hatches` count baseline (re-baselined 2026-05-12 with prod/test split)** — prod 19 / test 112 / total 131. Most prod hatches are deliberate type-narrowing in transports (LLM streaming response shapes, tool-call accumulators); most test hatches are the FakeWrapper fixture pattern (`as unknown as HTMLElement` to stub a minimal DOM surface for the wrapper-registry, biometric session-registry, and map registry tests). Increases ABOVE the prod count are the real finding; increases in test count are expected as test coverage grows.
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

## anti-patterns

Named failure-mode patterns we've been bitten by. Each entry: what it is, why it bites, how to find it (grep / human / both), known false-positive call sites with their exemption reason, and target to defuse.

The shape mirrors `## known-noise` / `## deferred` so the existing aging-out + revisit-trigger discipline applies. A new pattern is added the same day we discover one through debugging — the pattern's row IS the institutional memory.

- **Silent fallbacks** — `catch {}`, `catch (_) { /* ignore */ }`, `if (X.length === 0) return {}`, `?? null` followed by no error path. Production code that swallows a failure and returns a fallback shape instead of surfacing the problem. Bit us in: today's tool-loop bug (skill-whitelist refused calls → loop), the stale dispatcher-name surface (returned empty surface → no warning), the boot-once wiki cache. Detection: `run_silent_catches` in `scripts/health.sh` (count) + human eyeball in stress-test reviews. **Known false-positives (exempt):** (a) cleanup-on-shutdown swallows in `src/ui/modules/biometric/session-registry.ts` — `release()` MUST complete even if `session.stop()` throws; (b) `try { map.remove() } catch {}` in `src/ui/modules/map/map-registry.ts` — Leaflet's `.remove()` is non-idempotent and we deliberately tolerate double-dispose; (c) `try { /* */ } catch { /* ignore */ }` inside `scripts/health.sh` check functions themselves (file-read errors during the audit; the audit must not crash on a missing temp file). **Target to defuse:** baseline count captured in `.health/baseline.md`; new instances above baseline are findings.

- **Hand-coded magic numbers from a prior era** — `historyLimit: 10` (was sized for 4k-context models; bumped to 100 in 2026-05-12 for modern models), the deleted 2000-token budget cap (silently dropped pack tools), ping `maxTokens: 1` (insufficient for gpt-5 reasoning floor). Detection: human eyeball. No grep — magic numbers are by definition unannotated. **Known false-positives:** named timeouts/intervals that have a documented rationale (`RESET_COUNTDOWN_MS = 10 * 1000`, `port: 3000`). **Target to defuse:** when touching code with a numeric literal, ask "is this still sized for current reality?"

- **Boot-once caches of derived state with live inputs** — CLAUDE.md already documents this in detail under the wiki bug (b660b3e + `resolveActiveWikis` refactor). Cross-referenced here so the audit reader sees both lessons. Detection: human review when introducing a `setX(computeX())` at boot followed by reads that assume X is current. **Target to defuse:** prefer derive-on-read when inputs can change live.

- **README ↔ code drift** — claims in `README.md` that aren't true in `src/`. Bit us in: skill `allowed-tools` "metadata only in the current pass" while code enforced a runtime whitelist. Detection: structural assertions are brittle (README text changes); the practical check is `run_stale_doc_phrases` (greps for phrases like `today's behavior`, `in the current pass`, `not yet implemented` that outlive their truth). Plus human eyeball during stress-test on PRs that touch documented contracts. **Known false-positives:** the seeded entries in this very file use the phrase "today's behavior" historically in suppressions for legitimate reasons — limit the grep to `src/` and `README.md`, not `.health/`. **Target to defuse:** baseline count; new instances above baseline are findings.

- **Persistence captures the wrong abstraction** — `agent.config.tools` stored dispatcher names that became invalid after the trampoline refactor; required runtime expansion as a band-aid. Detection: human review when persisting a concrete name that derives from a synthesized or computed entity. **Target to defuse:** when introducing a new persistable field, ask "if I rename or restructure the referenced concept, will the persisted value still mean the right thing?"

- **Silently-ANDing permission gates with no single error path** — multiple independent checks that each return a failure shape, with no aggregated "tool was blocked by gate X" diagnostic. Caused the Cafe-room tool-loop incident: registry ∩ pack-activation ∩ agent.config.tools ∩ skill-whitelist all could refuse a call, and the user's mental model was "I see the tool, it should work." Detection: human review when introducing a new access gate alongside an existing one. **Target to defuse:** if you add an access check, ensure its failure carries a structured reason and isn't indistinguishable from another gate's failure.

- **Misleading log fields and warning text** — `[spawn] tools not found in registry: geo_tools, ...` warning fired on dispatcher names that are *expected* to be absent (they're synthesized at projection); `tools=N` log field counted tool calls EMITTED, not tools SENT, which sent debugging down a wrong path. Detection: human review when introducing a new log field or warning. **Target to defuse:** name fields after what they actually contain; words like "missing" and "not found" must mean what an operator thinks they mean.

- **Stale documentation phrases** — `today's behavior`, `in the current pass`, `not yet implemented`, `for now we...`, `TODO`, `FIXME` that outlive their truth. Greppable. Detection: `run_stale_doc_phrases` in `scripts/health.sh`. **Known false-positives:** phrases inside `.health/` entries themselves (excluded by the grep). Phrases in changelogs or release notes (excluded). `README.md:171` "Pack-namespaced resolution is not yet implemented" — this IS a legitimate documented limitation (skill `allowed-tools` names resolve against the global registry only); revisit when pack-namespaced skill scoping is added. **Target to defuse:** baseline count = 1.

- **README ↔ code factual drift** — README makes a specific factual claim (a version number, a tool count, a tier value) that the code's actual constant has since moved past. Bit us 2026-05-12: README.md:131 said `SNAPSHOT_VERSION = 11`, actual value was 22 (11 versions stale). Not greppable as a class — the phrase "SNAPSHOT_VERSION = 11" isn't on the stale-phrase list because it's a specific numeric claim. Detection: human spot-check during stress-test on PRs that touch documented constants; periodic adversarial cross-check (every quarter or whenever the README is materially revised) of high-value claims against source. **Target to defuse:** when stating a specific numeric or named value in README, prefer "the canonical value in `src/...` (currently N)" over a bare repeat — the indirection makes the drift loud rather than silent. (The fix in commit c0f4b44 demonstrates the pattern.)

- **Trust-boundary cast** — an HTTP endpoint or WS handler accepts unvalidated input and casts it directly to a typed shape with `body as unknown as T`. Bit us 2026-05-12: `PUT /api/rooms/:name/summary-config` cast the body to `SummaryConfig` without validation. The endpoint is auth-gated, so the blast radius is one logged-in user corrupting their own room state — but the type cast hides what should be a runtime validation gate, and the runtime failure mode is unpredictable (an invalid `schedule.kind` could silently break the scheduler). Detection: grep for `as unknown as` paired with `req`, `body`, or `params` in `src/api/`. **Known false-positives:** internal type-coercion between equivalent shapes (`raw as unknown as SystemSnapshot` after version check is acceptable because the version equality verifies the shape). **Target to defuse:** validate-at-the-boundary functions next to each route handler accepting external input; the cast should appear only inside the validator's return.

### meta-note

The grep check functions in `scripts/health.sh` (`run_silent_catches`, `run_stale_doc_phrases`) are themselves exempted from the patterns they detect. They contain `try { ... } catch { /* ignore */ }` around file reads because the audit MUST NOT crash on a missing temp file mid-run. This exemption is deliberate; do not "clean up" the audit script by removing its own swallow patterns. If the audit script grows beyond ~150 LOC of grep+count helpers, split it into a separate file with its own review burden.
