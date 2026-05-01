# Causality Tracking — Design Document

> **Status (2026-04):** V1 (`inReplyTo` stamping + LLM rendering) is implemented — see `src/agents/ai-agent.ts`, `src/agents/evaluation.ts`, `src/agents/context-builder.ts`, `src/core/types/messaging.ts`. The V2 tombstone section below is **historical**: the message-cap pruning it was designed to fix was removed in commit 33aad8b in favour of per-room summary + compression (`src/core/summaries/summary-engine.ts`, `src/core/summaries/summary-scheduler.ts`). `compressedIds` still exists on Room, but is now driven by the new compression path, not by a silent splice. Read V2 as background only.

## Problem Statement

Multi-agent room conversations are stored as flat timelines (`Message[]`). When an agent receives several messages while evaluating (they buffer in `incoming`), its response is causally linked to all of them — but the stored record only shows chronological order. There is no way to reconstruct who was responding to whom, especially when multiple agents respond to the same message independently, or when one agent's response is a joint reply to messages from several others.

The missing structure is a **directed acyclic graph (DAG)**: each message can have multiple parents (the buffered cluster that triggered it), and each message can have multiple children (all agents that independently responded to it). The current linear array is a degenerate case of this graph.

---

## Data Model

### inReplyTo on Message

```typescript
interface Message {
  // ... existing fields ...
  readonly inReplyTo?: ReadonlyArray<string>  // IDs of messages this responds to
}
```

**Semantics:** The set of message IDs that were in the agent's `incoming` buffer when `buildContext()` was called for the evaluation that produced this message. Concretely: `flushInfo.ids` at the moment of evaluation.

**Scope:** IDs are globally unique (`crypto.randomUUID()`). `inReplyTo` may reference messages from any context — current room, other rooms, DMs. An agent can only reference IDs it has actually received (structural guarantee: `flushInfo.ids` can only contain delivered messages).

**Backward compatibility:** Optional field. Existing messages have `inReplyTo: undefined`. No migration needed. Snapshot restore is unaffected since message arrays are preserved whole.

### What inReplyTo Is Not

- It is not a reference to the most recent message before this one (that's just temporal ordering, already captured by timestamp).
- It is not a thread ID or conversation ID (use `correlationId` for batch grouping).
- It is not a "quote" of the triggering content (content is in the referenced messages).

### Relationship to correlationId

| Field | Meaning | Direction |
|---|---|---|
| `correlationId` | Horizontal grouping — all messages from one `routeMessage()` call are siblings | Batch |
| `inReplyTo` | Vertical causality — this message was produced in response to these specific prior messages | Causal |

Both coexist. A broadcast response to 3 rooms gets one `correlationId` (they're siblings) and the same `inReplyTo` (they all reply to the same triggering cluster).

---

## The Source: flushInfo.ids

The causal parent information is already computed. `buildContext()` returns `FlushInfo`:

```typescript
interface FlushInfo {
  readonly ids: Set<string>          // messages in incoming at context-build time
  readonly dmMessages: Message[]
  readonly triggerRoomId?: string
  readonly triggerPeerId?: string
}
```

`ids` is exactly the set of `[NEW]` messages the LLM saw when deciding how to respond. After evaluation, `flushIncoming()` uses these same IDs to move messages to history. **This set is the causal antecedent of the response.** The data exists — it is not currently stamped onto the outgoing message.

In `ai-agent.ts`, `tryEvaluate()` already has both `decision` and `flushInfo` available side-by-side before calling `onDecision()`. The wiring is:

```typescript
// In tryEvaluate, after evaluate() returns:
onDecision({ ...decision, inReplyTo: [...flushInfo.ids] })
```

This applies to both `respond` and `pass` decisions. `pass` is posted as a visible `type: 'pass'` message and represents a conscious evaluation — it should carry causal parents for the same reason.

---

## LLM Context Rendering

### The Core Insight

For LLMs, adjacency in a transcript conveys causality more naturally than data annotations. The `[NEW]` marker already signals "these messages triggered this evaluation." The `inReplyTo` rendering makes the triggering relationship visible as named attribution rather than an opaque flag.

### Format

In `formatMessage()` in `context-builder.ts`, when a message has `inReplyTo`, prepend resolved sender names:

```
[Analyst → Michael, Alice]: The transformer load data shows...
```

Resolution: look up each `inReplyTo` ID in the message history being rendered for this context build, extract `senderName`. Fall back to `agentProfiles` map if the message isn't in the current window.

IDs are stable (agent names are immutable after creation in this system), so name resolution at render time is reliable.

### Resolution Algorithm — Three States

Written from V1 even though "compressed" is inert until V2:

```typescript
type ResolvedRef =
  | { type: 'found'; senderName: string }
  | { type: 'compressed' }   // message was dropped during room compression
  | { type: 'unknown' }      // ID not found anywhere — data integrity issue

const resolveRef = (id: string, roomCtx: RoomContext, allHistory: AgentHistory): ResolvedRef => {
  // 1. Current room history (most likely)
  const inRoom = roomCtx.history.find(m => m.id === id)
  if (inRoom) return { type: 'found', senderName: inRoom.senderName ?? inRoom.senderId }

  // 2. Other room histories (cross-context reference)
  for (const [, ctx] of allHistory.rooms) {
    const found = ctx.history.find(m => m.id === id)
    if (found) return { type: 'found', senderName: found.senderName ?? found.senderId }
  }

  // 3. DM history
  for (const [, ctx] of allHistory.dms) {
    const found = ctx.history.find(m => m.id === id)
    if (found) return { type: 'found', senderName: found.senderName ?? found.senderId }
  }

  // 4. Tombstone check (V2 populates this)
  if (roomCtx.compressedIds?.has(id)) return { type: 'compressed' }

  return { type: 'unknown' }
}
```

Rendered in LLM context:
- `found` → `[Analyst → Michael, Alice]:`
- `compressed` → `[Analyst → (summarised earlier)]:`
- `unknown` → `[Analyst → (ref: unknown)]:` — honest about the data gap

### Cross-Context Causality

An agent in Room Alpha also has a DM with Michael. Michael's DM says "can you expand on what you said to the team?" — the response is causally linked to both the DM and the original Room Alpha message. `inReplyTo` captures this precisely since IDs are globally scoped and resolution searches all contexts. This is the natural model for coordinator agents monitoring multiple subsystems.

**Invariant:** An agent can only appear in `inReplyTo` for messages it has actually received. This is structurally guaranteed — `flushInfo.ids` only contains messages from the agent's own `incoming` buffer, which only receives messages from rooms it's a member of and DMs addressed to it.

---

## Tombstone Infrastructure

### The Problem is Already Active

`room.post()` currently does:

```typescript
if (messages.length > messageLimit) {
  messages.splice(0, messages.length - messageLimit)  // silent drop
}
```

No tracking. No summary. Any `inReplyTo` reference to a spliced message becomes silently unresolvable. This must be fixed before `inReplyTo` is used in production rooms approaching the 500-message cap.

### Room-Level Changes

Room gains `compressedIds: Set<string>` alongside the existing `muted: Set<string>`. When the message cap is hit, instead of silent splice:

1. Collect dropped IDs: `const dropped = messages.slice(0, count).map(m => m.id)`
2. Add all to `room.compressedIds`
3. Post a `room_summary` landmark into the room: `{ type: 'room_summary', metadata: { compressedIds: dropped }, content: 'N messages archived (timestamp range)' }` — system-generated factual content, no LLM call
4. Splice the old messages

The landmark message serves three purposes: (a) visible seam in history for humans, (b) delivers `compressedIds` to agents via normal message delivery, (c) persists in snapshot as part of the room's message array.

### Agent-Side Propagation

`RoomContext` in `AgentHistory` gains `compressedIds?: Set<string>`.

In `ai-agent.ts receive()`, when a `room_summary` message arrives with `metadata.compressedIds`, the agent adds those IDs to `RoomContext.compressedIds`. This is the propagation step: the room's compression event travels through the normal message delivery path into each agent's history.

```typescript
// In receive(), when message.type === 'room_summary' && message.metadata?.compressedIds:
const ctx = agentHistory.rooms.get(message.roomId)
if (ctx) {
  const ids = message.metadata.compressedIds as string[]
  ctx.compressedIds = new Set([...(ctx.compressedIds ?? []), ...ids])
}
```

### Snapshot Persistence

`compressedIds` on Room serializes as a plain array in `RoomSnapshot` (same pattern as `muted`). On restore, `restoreState()` receives and repopulates the set. Agents rebuild their `RoomContext.compressedIds` naturally when they rejoin: the `room_summary` landmark messages are part of the restored room history, delivered via `injectMessages()` and processed in `join()`.

No special restore path needed — the landmark messages carry the compressed IDs through the existing message stream.

### RoomState and WS Sync

`RoomState` gains `compressedIds?: ReadonlyArray<string>` for the WS snapshot. Agents reconnecting receive the current `compressedIds` state without needing to replay history.

---

## Edge Cases and Known Gaps

### pass Messages
`pass` decisions are posted as `type: 'pass'` messages. They should carry `inReplyTo` — a pass is a conscious evaluation of the incoming messages, and the causal relationship is the same as for a respond. Wiring is identical.

### Join Summaries
`join()` generates a private summary of recent room history via a direct `llmProvider.chat()` call, bypassing the evaluation pipeline. The summary's natural parents are the messages in `room.getRecent(historyLimit)`. These IDs are explicitly available. `inReplyTo: recent.map(m => m.id)` could be set, but this is low priority since join summaries are onboarding artifacts, not conversation participants.

### post_to_room Tool
When an agent calls `post_to_room` during a tool loop, the message is posted directly through `house.getRoom().post()` inside the tool implementation. `ToolContext` carries `callerId`/`callerName` but no `inReplyTo`. These tool-originated posts appear as causally unanchored. The fix would require threading the current evaluation's `flushInfo.ids` through `ToolContext`, which is more invasive. Accepted gap for now.

### History Window Slicing
The LLM sees only `historyLimit` messages, but `AgentHistory` stores the full unbounded history. `inReplyTo` IDs reference full-history IDs. Parents outside the LLM window are still valid in the graph but the LLM didn't see them in this evaluation. The graph is for system-level causality tracking; the LLM context window is a separate concern.

### compressedIds Set Growth
Every spliced message ID is kept in `compressedIds` forever. A room with 10,000 lifetime messages at a 500-message cap accumulates ~9,500 IDs. Manageable for now. Pruning policy (e.g. discard IDs older than N days) is a future concern.

### Summary Content Quality
V2 compression summaries are system-generated factual text ("N messages archived"). LLM-quality summaries require a trigger mechanism and an agent to generate them — this is V3. The tombstone tracking (which IDs were dropped) is independent of summary quality and should not wait for V3.

---

## Implementation Plan

### V1 — inReplyTo Stamping + LLM Rendering (~50 lines, 7 files)

| File | Change |
|---|---|
| `types.ts` | Add `inReplyTo?: ReadonlyArray<string>` to `Message` |
| `evaluation.ts` | Add `inReplyTo?: ReadonlyArray<string>` to `Decision` |
| `ai-agent.ts` | Wire `[...flushInfo.ids]` → `decision.inReplyTo` in `tryEvaluate`; applies to both respond and pass |
| `spawn.ts` | Pass `inReplyTo` from decision through `routeMessage` params |
| `delivery.ts` | Thread `inReplyTo` into `room.post()` params |
| `room.ts` | Include `inReplyTo` in `createRoomMessage()` |
| `context-builder.ts` | Update `formatMessage()` to render `[Sender → Name1, Name2]:` with three-state resolution |

No snapshot format change. No storage structure change. No UI change required.

### V2 — Tombstone Infrastructure (~80 lines, 8 files)

Required before V1 is used in rooms approaching the 500-message cap.

| File | Change |
|---|---|
| `types.ts` | Add `compressedIds?: ReadonlyArray<string>` to `RoomState`; add `compressedIds?: Set<string>` to `RoomContext`; add to `RoomRestoreParams` |
| `room.ts` | Replace silent splice with tombstone-aware compression: collect dropped IDs, post `room_summary` landmark with `metadata.compressedIds`, add to `Room.compressedIds`, then splice |
| `room.ts` | Add `compressedIds: Set<string>` to Room internal state; include in `getRoomState()` and `restoreState()` |
| `snapshot.ts` | Serialize `compressedIds` array in `RoomSnapshot` |
| `ai-agent.ts` | In `receive()`: detect `room_summary` with `metadata.compressedIds`, update `RoomContext.compressedIds` |
| `context-builder.ts` | Activate "compressed" branch in `resolveRef()` using `RoomContext.compressedIds` |
| `ws-handler.ts` | Include `compressedIds` in `buildSnapshot()` room state |
| `core/types.ts` | `WSOutbound` snapshot variant already includes `roomStates: Record<string, RoomState>` — picks up compressedIds automatically |

### V3 — LLM-Quality Compression Summaries (Deferred)

Explicit trigger (tool call or API endpoint) runs an LLM over the batch before splicing, posts result as the landmark's content. Architecture unchanged from V2. Only the summary generation path improves.

---

## Files Not Affected

| File | Reason |
|---|---|
| `core/house.ts` | Room management only, no message content |
| `core/rooms/delivery-modes.ts` | Flow/broadcast logic, no message creation |
| `tools/built-in/*` | Tool results don't carry inReplyTo (known gap, accepted) |
| `integrations/mcp/` | Messages returned as-is, inReplyTo included automatically |
| `api/http-routes.ts` | Reads messages from room, inReplyTo included automatically |
| UI | inReplyTo available for threaded rendering, no changes required for V1/V2 |
