# Samsinn experiment runner

Automated batch execution of prompt-configuration variants against a samsinn subprocess. Designed for controlled comparisons: *same trigger, different models / personas / temperatures / tools / seeds → collect conversation data → analyze elsewhere.*

## TL;DR

```bash
bun run experiments/cli.ts experiments/examples/hello-world.ts
```

Each variant × repeat spawns its own ephemeral samsinn subprocess, drives it over MCP stdio through the four Phase 1 primitives (`create_agent` with seed, `wait_for_idle`, `export_room`, `SAMSINN_EPHEMERAL`), and writes one JSON per run plus an incrementally-updated `summary.json`.

## Spec format

Specs are TypeScript modules exporting an `ExperimentSpec`. No YAML parser, no schema file — full IDE autocomplete, multi-line strings via template literals, comments supported, and specs can compute variant arrays in a `for` loop.

```ts
import type { ExperimentSpec } from '../types.ts'

const spec: ExperimentSpec = {
  experiment: 'persona-steering',
  base: {
    room: { name: 'trial', roomPrompt: '...' },
    trigger: { content: '...', senderName: 'researcher' },
    agents: [ /* common to all variants (optional) */ ],
  },
  variants: [
    { name: 'cold', agents: [{ name: 'solver', model: 'anthropic:claude-haiku-4-5', persona: '...', temperature: 0.0, seed: 42 }] },
    { name: 'warm', agents: [{ name: 'solver', model: 'anthropic:claude-haiku-4-5', persona: '...', temperature: 1.0, seed: 42 }] },
  ],
  repeats: 3,            // each variant runs this many times
  wait: { quietMs: 5_000, timeoutMs: 60_000 },
  outputDir: 'experiments/out/persona-steering',
}
export default spec
```

**Required fields**: `experiment`, `base.room.name`, `base.trigger.content`, `variants` (≥1), `wait.quietMs`, `wait.timeoutMs`, `outputDir`.

**Variant names** must match `/^[a-zA-Z0-9_-]+$/` (they land in output filenames). Duplicates are rejected.

### AgentSpec fields

Every field below maps 1:1 to the samsinn `AIAgentConfig`. Required: `name`, `model`, `persona`. Everything else is optional; omitting preserves samsinn's default.

| Field | Type | Research use |
|---|---|---|
| `temperature` | `number` | Sampling randomness. |
| `seed` | `number` | Deterministic seed (best-effort per provider). |
| `tools` | `string[]` | Restrict the agent's tool set. Omit = all registered tools. Empty array = no tools. |
| `historyLimit` | `number` | How many old messages stay in context. |
| `maxToolIterations` | `number` | Tool-loop depth cap. |
| `maxToolResultChars` | `number` | Per-tool-call result truncation fed back to the LLM. |
| `tags` | `string[]` | Capability/role tags — enables `[[tag:X]]` addressing. |
| `thinking` | `boolean` | Enable CoT (qwen3 thinking mode, etc.). |
| `includePrompts` | object | Per-section gates. **Keys don't match UI labels — see table below.** |
| `includeContext` | object | CONTEXT sub-section toggles (`participants`, `macro`, `artifacts`, `activity`, `knownAgents`). |
| `includeTools` | `boolean` | Master: send tool definitions to LLM at all. |
| `promptsEnabled` | `boolean` | Master: every `includePrompts` section off when `false`. |
| `contextEnabled` | `boolean` | Master: every `includeContext` sub-section off when `false`. |

**`includePrompts` key ↔ UI label mapping** (confusing — always consult this table):

| UI label | Key |
|---|---|
| Agent persona | `persona` |
| Room prompt | `room` |
| System prompt | `house` (NOT `system`) |
| Response format | `responseFormat` |
| Skills | `skills` |

So to run an ablation that disables the skills section: `includePrompts: { skills: false }`.

**Paths** (`outputDir`, the spec path passed to the CLI) are resolved against `process.cwd()`, not the spec file's location.

## Output layout

```
<outputDir>/
  <variant>-run000.json    # one per (variant, runIndex)
  <variant>-run001.json
  ...
  summary.json             # rewritten after every run
```

### Run file shape
```json
{
  "experiment": "persona-steering",
  "variant": "cold",
  "runIndex": 0,
  "status": "ok",                  // "ok" | "timeout" | "error" | "capped"
  "startedAt": 1777035282929,
  "finishedAt": 1777035283437,
  "elapsedMs": 508,
  "export": {                      // absent on startup failure
    "roomId": "...",
    "roomName": "trial",
    "messageCount": 14,
    "messages": [ /* every message + telemetry + toolTrace */ ]
  },
  "error": "...",                  // only on status: error
  "timedOut": true,                // only on status: timeout
  "capped": true                   // only on status: capped
}
```

### Tool-call traces

Messages posted by agents that invoked tools carry a `toolTrace` array — one entry per call made during that turn. Omitted when the agent didn't call any tools.

```json
{
  "senderName": "solver",
  "content": "The weather in Paris is 14°C and cloudy.",
  "type": "chat",
  "promptTokens": 82, "completionTokens": 14, "provider": "anthropic",
  "toolTrace": [
    { "tool": "get_weather", "arguments": { "city": "Paris" },
      "success": true, "resultPreview": "{\"temp\":14,\"cond\":\"cloudy\"}" }
  ]
}
```

`resultPreview` is always ≤200 chars (truncated with `…`). Errors surface in `resultPreview` too, with `success: false`. Enables analyses like: *"which variants used web_search? how often did they hit errors? does tool use correlate with answer quality?"*

### Summary shape
```json
{
  "experiment": "persona-steering",
  "specDigest": "72237be54114",
  "startedAt": 1777035258043,
  "finishedAt": 1777035295176,
  "totalElapsedMs": 37133,
  "runCount": 6,
  "status": "done",
  "variantStats": {
    "cold": { "succeeded": 3, "failed": 0, "timedOut": 0 },
    "warm": { "succeeded": 2, "failed": 0, "timedOut": 1 }
  }
}
```

**`specDigest`** is `sha256(spec file contents).slice(0, 12)`. Useful to cross-reference results against the spec that produced them. (Note: only the spec file is hashed — if your spec imports helpers, those aren't part of the digest.)

**Token totals are not aggregated in the summary** by design — every run JSON carries per-message token counts, which an analysis pipeline (pandas, DuckDB, etc.) will want to aggregate its own way.

## Interpreting `status`

- **`ok`** — conversation reached quiescence: `wait_for_idle` returned `idle: true` AND all in-room AI agents resolved `whenIdle()`.
- **`timeout`** — `wait_for_idle` hit `timeoutMs` without quiescence or cap. Export still captured. Raise `wait.timeoutMs` if this fires often on long-reasoning models.
- **`capped`** — `wait.maxMessages` reached. Intentional — your cap fired because a conversation ran long (agents in a loop, debate, etc.). Not a failure; the data is still good.
- **`error`** — something threw: subprocess startup failure, MCP tool error, spawn-related, JSON parse of MCP response. `error` field carries the message.

Errors do NOT abort the batch — the next run starts fresh. Exit code is 0 iff ≥1 run succeeded.

## Multi-agent primitives

### Base agents

`base.agents: AgentSpec[]` (optional) adds agents common to every variant, in addition to each variant's `agents`. Useful for a fixed "moderator" or "adversary" present across all variants while the variant-specific agents change.

### Seed messages (`base.baseMessages`)

Optional seed messages posted before the trigger. The runner:
1. Creates the room + agents
2. **Pauses** the room (agents don't evaluate)
3. Posts each seed message
4. Unpauses the room
5. Posts the trigger
6. Calls `wait_for_idle`

Agents see every seed message in their history when they first evaluate (triggered by the trigger). Use this to pre-seed few-shot context, carry-in prior turns, or set scene.

```ts
base: {
  room: { name: 'trial' },
  trigger: { content: 'Now what?', senderName: 'researcher' },
  baseMessages: [
    { content: 'Earlier: the suspect was seen near the bank at 9pm.', senderName: 'context' },
    { content: 'Earlier: a witness described a blue coat.', senderName: 'context' },
  ],
}
```

### Max-messages cap (`wait.maxMessages`)

Hard cap on room message count. When hit, `wait_for_idle` returns immediately with `capped: true` and the run's status becomes `'capped'` (not an error).

**The cap counts every message in the room**: seed messages + trigger + agent responses. If `baseMessages.length === 3` + 1 trigger + `maxMessages: 6` → agents get at most 2 responses before cap.

Essential for agent-vs-agent debates where agents might otherwise loop indefinitely.

### Delivery mode (deferred)

`deliveryMode` is not yet a spec field. The underlying `set_delivery_mode` MCP tool currently only sets broadcast (which is the default anyway). Manual mode exposure is a follow-up. For now every experiment runs in broadcast mode — every agent in the room sees every message.

## Exit codes

- `0` — at least one run succeeded
- `1` — all runs failed, OR spec loading/validation error
- `2` — bad CLI usage

## Isolation modes

`spec.isolation` controls how runs are kept independent from each other.

| Mode | Behavior | Per-run cost | Trade-offs |
|---|---|---|---|
| `'subprocess'` (default) | One samsinn subprocess per run | ~7.5s startup + real work | Bulletproof isolation. Every run gets a clean tool registry, skill store, provider state, and process memory. |
| `'reset'` | One subprocess for the whole batch; `reset_system` MCP tool clears rooms/agents/artifacts between runs | First run pays startup, rest pay only ~500ms reset + real work | Order-of-magnitude faster. Preserves tool registry, skill store, warmed model caches, **and provider router cooldowns** across runs. Small memory growth in the router's per-agent Map (bounded, negligible in practice). |

Measured on the included `zero-agent` example (4 trivial runs, no LLM calls):

| Mode | 4-run wall time |
|---|---|
| `subprocess` | ~31s |
| `reset` | ~8s |

Speedup grows with batch size: a 50-run reset-mode batch completes in ~35s (~700ms per run average), whereas subprocess mode would take ~6 minutes.

**Use `subprocess` when**: you want maximum isolation, or you suspect samsinn's in-memory state could affect results across runs (e.g. running with summary-scheduler enabled, or with tools that mutate process-wide state).

**Use `reset` when**: you're running >20 runs and the overhead matters, and your experiments don't depend on cold provider-router state (rate-limit cooldowns from one run DO carry into the next — often desirable, but be aware).

```ts
const spec: ExperimentSpec = {
  // ...
  isolation: 'reset',  // opt in
}
```

## Cost considerations

LLM cost is determined by your spec: model × temperature × message count × repeats. Samsinn subprocess overhead is addressed by the isolation modes above.

## Interrupt handling

SIGINT (Ctrl-C) stops the batch after the in-flight run's result + summary have been written. No partial writes. Running samsinn subprocess is cleanly torn down. The next run in the plan will NOT start.

## Troubleshooting

**"Samsinn subprocess did not become ready within 30000ms"** — the MCP `initialize` handshake didn't complete in time. Usually means samsinn failed to start. The error message carries the last 20 lines of samsinn stderr — read those. Common causes: a provider with a bad API key timing out during model-list warmup, a snapshot read error (irrelevant in ephemeral mode), or a syntax error in a custom tool/skill that was loaded at startup.

**Many `status: timeout` results** — raise `wait.timeoutMs` or `wait.quietMs` for models that think longer. Defaults in the example (60s timeout / 5s quiet) work for chat-sized turns; agentic workflows with tool loops want ~180s timeout.

**`status: ok` but `messageCount: 1`** — only the trigger message was captured. Usually means no agent was added to the room, or the agent responded with `pass`. Check the variant's agent list.

## Examples

- **`examples/zero-agent.ts`** — no-LLM smoke spec, subprocess mode. Runs in seconds without any API key.
- **`examples/zero-agent-reset.ts`** — same shape, `isolation: 'reset'`. Use to verify reset mode locally.
- **`examples/zero-agent-subprocess.ts`** — explicit subprocess mode for side-by-side perf comparison.
- **`examples/hello-world.ts`** — one real Anthropic agent, two temperature variants. Requires `ANTHROPIC_API_KEY` in the environment (or a key stored in `~/.samsinn/providers.json`).
- **`examples/two-agent-debate.ts`** — optimist vs. pessimist debate, demonstrates `baseMessages`-free multi-agent setup and `maxMessages` cap. Requires Anthropic key.
- **`examples/ablation.ts`** — one agent across four variants differing only in `includePrompts` / `promptsEnabled`. Reset mode. Requires Anthropic key.

## What this runner does NOT do

- Statistical analysis, significance tests, or plots. Run JSONs are structured so pandas/DuckDB can ingest them directly.
- Parallel variant execution. LLM rate limits are the real bottleneck.
- Tool-call traces. Messages in the export carry tokens/provider/model/generationMs, but intermediate tool calls are internal to samsinn's evaluation loop and not persisted on messages.
- Batch resumption. If a batch is interrupted, re-run the whole spec; the previous output directory will be overwritten run-by-run as new runs complete.
