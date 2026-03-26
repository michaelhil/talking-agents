# Turn-Taking: Room-Controlled Staleness-Based Design

## Problem

Currently when a message arrives in a room, every member agent receives it simultaneously via `receive()`. Each independently decides to respond or pass. This causes:

- **Pile-ups**: Multiple agents respond to the same message at once
- **Echo loops**: Agent A responds, triggers Agent B, triggers Agent A again
- **No structure**: Rooms with many agents have no concept of conversation phases

## Design Decision: Room Controls Turn-Taking

Room is the natural place for turn-taking because it already owns the delivery loop (`post()` iterates members and calls `deliver()`). The room has the message array, the member list, and the delivery mechanism. No external coordinator needed.

## Core Concept: Staleness-Based Turn Order

The room's message array is the single source of truth for turn order. **Staleness = who hasn't spoken the longest**, determined by scanning the message array backwards.

### No Extra State Needed

The message array IS the turn order. No separate queue, no round counter, no coordinator object. Given the same message history, the order is always deterministic.

### Algorithm

When turn-taking (TT) mode is on, the room changes how it delivers messages:

1. Instead of broadcasting to all members, the room **delivers to one agent at a time**
2. The room picks the **stalest agent** — the participating agent whose last message is furthest back in the array
3. That agent receives all undelivered messages + history, generates a response
4. The response is posted to the room. The room then finds the **next stalest** agent and delivers to them
5. This continues endlessly until paused

### Worked Example

Four AI agents: A, B, C, D. All participating in turn-taking.

```
Message history (oldest → newest):
  ... C ... D ... A ... [TT enabled] ... B(new, undelivered) ... D(new, undelivered)

B and D were generating before TT mode kicked in. Their replies arrive and are
buffered as undelivered messages.

Staleness ranking (last-message position, furthest back = stalest):
  1. C  (stalest — hasn't spoken since way back)
  2. A  (second stalest)
  3. B  (just posted)
  4. D  (freshest — just posted most recently)
```

**Round proceeds: C → A → B → D**

| Step | Room action | Result |
|------|-------------|--------|
| 1 | Find stalest → **C**. Deliver B+D's messages to C with history | C generates response |
| 2 | C responds. Find next stalest → **A**. Deliver C's reply to A with history | A generates response |
| 3 | A responds. Find next stalest → **B**. Deliver A's reply to B with history | B generates response |
| 4 | B responds. Find next stalest → **D**. Deliver B's reply to D with history | D generates response |
| 5 | D responds. All have spoken. Stalest is now C again → new round starts | Continues endlessly |

### Properties

- **Self-correcting** — if an agent speaks more, they naturally get pushed later. If someone's been quiet, they get priority
- **Deterministic** — given the same message history, the order is always the same
- **Continuous** — rounds continue endlessly until the user hits Pause
- **Zero extra state** — the message array is the turn order

## Design Details

### Pass Messages Count as Speaking

When an agent responds with `::PASS::`, that pass message is added to the room's message array. This updates the agent's staleness position — they "spoke" (even if they had nothing to add). This prevents a passing agent from perpetually being selected as stalest.

### Per-Agent Participation Checkboxes

The UI provides checkboxes next to each agent (both AI and human) to include or exclude them from turn-taking. Only agents with TT participation enabled are considered in the staleness calculation and receive turn-based delivery.

- Agents not participating still see all messages in the UI (messages always appear for everyone)
- Non-participating agents do NOT receive `deliver()` calls during TT rounds
- Participation can be toggled at any time — agent joins or leaves the rotation immediately

### Human Agents in Turn-Taking

Human agents can participate in turn-taking via the checkboxes. When it is a human's turn:

- The TT chain **pauses** and waits for the human to submit a message
- All messages still appear in the UI in real-time (no hiding)
- Once the human submits, their message is posted and the TT chain resumes with the next stalest agent
- If a human is not participating (checkbox unchecked), they are skipped in the rotation but can still post messages freely

### Continuous Rounds / Pause Control

- TT mode runs **endlessly** — after all participating agents have spoken, it loops back to the stalest and starts a new round
- A **Pause button** in the UI stops the automatic chain. No new deliveries happen until resumed
- A **Resume button** restarts from the current stalest agent
- Human turn = implicit pause (waits for human input, then auto-resumes)

### All Messages Visible in UI

Regardless of TT mode, all messages always appear in the UI for all room members. TT mode only controls the **delivery to agents** (who gets `receive()` called and when). The WebSocket broadcast to human clients is unaffected.

## Integration Points in Codebase

### 1. Room-level TT state

Extend Room with turn-taking controls:

```typescript
// New fields on Room
readonly turnTaking: {
  readonly enabled: boolean
  readonly participating: ReadonlySet<string>  // agent IDs in rotation
  readonly paused: boolean
  readonly currentTurn?: string                // agent ID currently generating
}
readonly setTurnTaking: (enabled: boolean) => void
readonly setParticipating: (agentId: string, participating: boolean) => void
readonly pauseTurnTaking: () => void
readonly resumeTurnTaking: () => void
```

### 2. Modified delivery in Room.post()

When TT is enabled, `post()` changes behavior:

```typescript
// Current: deliver to ALL members
for (const id of members) deliver(id, message, history)

// TT mode: buffer the message, then deliver to ONE agent (stalest)
// Find stalest participating agent by scanning messages array backwards
// Deliver only to that agent
// Wait for their response (which comes back as another post())
// Then find next stalest and deliver again
```

### 3. Staleness calculation

```typescript
// Scan messages array from end to find each participating agent's last message
// Agent with the oldest last-message (or no message at all) is stalest
const findStalestAgent = (
  messages: ReadonlyArray<Message>,
  participating: ReadonlySet<string>,
  exclude?: string,  // agent that just spoke
): string | undefined => {
  const lastSeen = new Map<string, number>()  // agentId → array index

  for (let i = messages.length - 1; i >= 0; i--) {
    const senderId = messages[i].senderId
    if (participating.has(senderId) && !lastSeen.has(senderId)) {
      lastSeen.set(senderId, i)
    }
    if (lastSeen.size === participating.size) break  // found all
  }

  // Agent with lowest index (or not found at all) is stalest
  let stalest: string | undefined
  let stalestIndex = Infinity

  for (const id of participating) {
    if (id === exclude) continue
    const index = lastSeen.get(id) ?? -1  // never spoken = maximally stale
    if (index < stalestIndex) {
      stalestIndex = index
      stalest = id
    }
  }

  return stalest
}
```

### 4. WebSocket / UI additions

- Toggle TT mode per room (switch in room header)
- Per-agent participation checkboxes (in agent list or room member panel)
- Pause/Resume button (visible when TT is active)
- Visual indicator of whose turn it is
- Visual indicator when waiting for human input

## Earlier Ideas (Archived)

### State Machine Approach (not chosen)

An earlier concept modeled conversation as a finite state machine with explicit states (IDLE, FLOOR_OPEN, GENERATING, YIELDING). This was rejected in favor of the staleness approach because:

- State machine requires extra state and transitions to manage
- Staleness approach derives order from existing data (message array)
- State machine needs explicit round boundaries; staleness is continuous
- State machine is more complex to implement and debug

### Speaker Selection Strategies (not chosen)

Other selection strategies considered but not chosen for initial implementation:

1. **Relevance bid** — fast cheap LLM call per agent, highest relevance goes first
2. **Role-based** — room metadata defines speaker priority
3. **Addressed agent** — if message mentions agent by name, they go first
4. **Coordinator agent** — designated agent decides who speaks next

These could be added later as alternative selection modes alongside staleness.

## Directed Addressing: `[[AgentName]]` Syntax

Agents (and humans) can target specific agents within a message using `[[AgentName]]` syntax. This overrides the normal staleness-based selection for one turn.

### How It Works

1. Agent B posts: `"[[Analyst-1]] what do you think about the current situation?"`
2. The room parses the message content for `[[...]]` patterns and resolves them to agent IDs
3. Instead of delivering to the stalest agent, the room delivers **only to the addressed agent(s)**
4. The message is still added to the room's message array — all agents will see it as history context when their turn comes
5. After the addressed agent responds, normal staleness-based ordering resumes

### Multiple Targets

Multiple agents can be addressed in a single message:

- `"[[Analyst-1]] [[Researcher-2]] compare your findings"` → deliver to both, in staleness order between them
- Each addressed agent takes a turn in sequence (stalest of the addressed set goes first)

### Interaction with TT Mode

| TT Mode | Addressing | Behavior |
|---------|-----------|----------|
| Off | No `[[...]]` | Current behavior — broadcast to all members |
| Off | `[[Agent]]` present | Deliver only to addressed agent(s) instead of broadcast. Others see it as history context next time they receive a message |
| On | No `[[...]]` | Normal staleness-based delivery |
| On | `[[Agent]]` present | Skip staleness, deliver to addressed agent(s) only, then resume staleness order |

`[[AgentName]]` addressing works in both modes. It is a general-purpose delivery filter independent of turn-taking.

### Addressing a Non-Participating Agent

If the addressed agent has TT participation unchecked, the message is still posted to the room array but the addressed delivery is skipped (agent is excluded from the rotation). The TT chain resumes with the next stalest participating agent.

### Addressing a Human

If `[[HumanName]]` is used, the TT chain pauses and waits for the human to respond (same as when it's a human's turn in normal rotation). The human sees a visual indicator that they've been directly addressed.

### Implementation

```typescript
// Parse [[AgentName]] patterns from message content
const AGENT_ADDRESS_RE = /\[\[([^\]]+)\]\]/g

const parseAddressedAgents = (content: string): ReadonlyArray<string> => {
  const names: string[] = []
  let match: RegExpExecArray | null
  while ((match = AGENT_ADDRESS_RE.exec(content)) !== null) {
    names.push(match[1]!)
  }
  return names
}
```

In the room's TT delivery logic:

```typescript
// After a message is posted, check for directed addressing
const addressedNames = parseAddressedAgents(message.content)

if (addressedNames.length > 0) {
  // Resolve names to agent IDs, filter to participating members
  // Deliver to addressed agents in staleness order among them
} else {
  // Normal staleness-based selection
}
```

### Context for LLM

The response format instructions should explain the `[[AgentName]]` syntax so agents know they can use it:

```
To direct a message to a specific agent, use [[AgentName]] in your response.
Example: "[[Analyst-1]] can you elaborate on that point?"
You can address multiple agents: "[[Analyst-1]] [[Researcher-2]] compare notes."
The addressed agent(s) will respond next. Other agents will see your message as context later.
```

## Markdown Compatibility

LLM agents produce Markdown in their responses so the UI can render rich formatting. Our special syntaxes do not conflict with standard Markdown:

- **`[[AgentName]]`** — not standard Markdown. Double brackets are wiki-link syntax (Obsidian/Notion) but not part of any Markdown spec a renderer would act on.
- **`::PASS::` / `::TOOL::`** — not standard Markdown. Some extended flavors use `:::` for containers but `::TEXT::` is unused.

### Edge Case: Special Syntax Inside Code Blocks

An LLM might write Markdown code blocks containing our syntax literally, e.g. `` `[[example]]` `` or a fenced block with `::PASS::`. To prevent false matches:

- **`::PASS::` / `::TOOL::`** — already parsed only at the start of the raw LLM response (before any message is created). No risk of false match inside message content.
- **`[[AgentName]]`** — parsed from message content, so code blocks could produce false matches. **Mitigation: validate parsed names against the room's current member list.** If `[[addressing]]` doesn't match any known agent name, it's ignored. No Markdown-aware parsing needed — just check against real names.

## Implementation Status (v0.5.5)

All features in this document have been implemented:

- **Delivery modes**: broadcast, targeted, staleness, flow — unified in Room.post() with delivery-modes.ts extraction
- **Staleness turn-taking**: fully working with pause/resume, participation toggles, currentTurn tracking
- **Flows**: CRUD, execution, step prompts via metadata, loop support, auto-switch to targeted on completion
- **Muting**: per-agent per-room, mute/unmute system messages in history, muted agents skipped in all modes
- **`[[AgentName]]` addressing**: works in all modes, validated against room members
- **Markdown**: marked + DOMPurify in UI, prose styles, LLMs told they can use Markdown
- **UI**: mode selector dropdown, mute buttons, targeted send modal, flow editor modal, flow selector
- **API**: full REST + WebSocket support for all features

## Remaining Open Questions

- Timeout: what if the agent with the floor takes too long or crashes? Need a configurable timeout that auto-skips
- Should there be a max-rounds limit to prevent infinite loops of passes?
- AI-initiated flows: agents creating and triggering flows via tools (data model supports it, tools not yet created)
- Flow editor drag-and-drop reordering (currently uses ▲/▼ buttons)
