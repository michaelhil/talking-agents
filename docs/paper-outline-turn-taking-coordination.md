# Coordination and Turn-Taking in Multi-Agent Human-AI Communication Systems

## Paper Outline — Research Directions and Design Insights from Samsinn

---

## 1. Introduction and Problem Statement

### 1.1 The Multi-Agent Conversation Problem
- When multiple AI agents and humans share a communication space, the fundamental question is: **who speaks when, to whom, and in what order?**
- Unlike human conversations where social norms, body language, and turn-taking cues are implicit, AI agents have no native turn-taking instincts
- Without coordination, multi-agent rooms produce pathological behaviors:
  - **Pile-ups**: all agents respond simultaneously to the same message
  - **Echo loops**: Agent A responds, triggering Agent B, triggering Agent A, infinitely
  - **Redundancy**: multiple agents give the same answer, wasting compute
  - **Context starvation**: agents respond before seeing each other's contributions, missing opportunities for building on ideas
  - **Domination**: faster models or shorter-response agents crowd out slower, more thoughtful ones

### 1.2 Why This Matters
- Multi-agent systems are increasingly used for collaborative reasoning, research, creative work, and decision support
- The quality of multi-agent output depends not just on individual agent capability but on the **coordination protocol** governing their interaction
- Current approaches (e.g., AutoGen, CrewAI) often hardcode turn order or use simple round-robin — we argue that the coordination mechanism itself should be a first-class, configurable, and potentially AI-driven component
- Human participants add another dimension: they operate at different speeds, have different expectations of responsiveness, and may want to steer conversation flow dynamically

### 1.3 Scope and Contributions
- We present a taxonomy of coordination mechanisms for multi-agent rooms
- We describe practical implementations and their trade-offs, based on building Samsinn — a real multi-agent room communication system
- We identify open problems and propose future directions including AI-driven coordination

---

## 2. System Model and Communication Architecture

### 2.1 Core Abstractions
- **Room**: a shared communication space with an ordered message array, a member set, and a delivery mechanism
  - Room is a self-contained component: messages + members + delivery logic
  - Room owns the message history — the single source of truth for conversation state
  - Room controls delivery: its `post()` function decides who receives each message
- **Agent**: a unified interface for both AI and human participants
  - AI agents: receive message → build context → call LLM → post response
  - Human agents: receive message → push to transport (WebSocket, API, etc.)
  - Same interface means coordination mechanisms are agent-type-agnostic
- **Message**: the atomic unit of communication
  - Includes: sender, content, timestamp, type (chat/join/leave/system/pass/mute)
  - Messages are immutable once posted — no editing, only appending
  - Messages can carry metadata (e.g., step prompts, tool results)
- **Message Router**: a function that routes messages to rooms and/or directly to agents

### 2.2 Communication Channels

#### 2.2.1 Room-Based Communication
- Messages posted to a room are stored in the room's message array
- Delivery to members is controlled by the room's active delivery mode
- All members eventually see all messages (as history context), even if delivery was delayed or selective
- Room-based communication is the primary channel and is observable by all members

#### 2.2.2 Direct Agent-to-Agent Communication (DMs)
- Agents can bypass rooms and communicate directly via the message router
- DMs use the same Message format but with `recipientId` instead of `roomId`
- DMs are private — only sender and recipient see them
- This creates a **hidden channel** that coordination mechanisms cannot observe
- Implications for coordination: agents may reach agreements via DMs that affect room behavior, and the room's turn-taking mechanism has no visibility into this
- DMs are useful for:
  - Private negotiations between agents before presenting a unified view
  - Side-channel queries (e.g., "do you agree with my analysis?")
  - Efficient bilateral exchange without flooding the room

#### 2.2.3 Tool-Based Inter-Agent Communication
- AI agents can call tools during their generation cycle (between LLM iterations in a ReAct loop)
- One built-in tool is `query_agent`: synchronously ask another agent a question and receive a response
- This is a **third communication channel** — neither room-based nor DM-based
  - The queried agent processes the question immediately (bypassing any turn-taking)
  - The response is fed back into the querying agent's context as a tool result
  - Neither the query nor the response appears in any room's message history
  - The room's coordination mechanism is completely unaware of this exchange
- This creates an interesting tension: tool-based queries can short-circuit carefully designed turn-taking, but they're also essential for efficient information gathering

#### 2.2.4 Channel Interaction and Implications
- Three channels operating simultaneously create a complex communication topology
- A coordination mechanism that only governs room delivery is incomplete — agents can always sidestep it via DMs or tools
- This mirrors real-world human communication: formal meetings (rooms) coexist with hallway conversations (DMs) and quick questions (tool queries)
- Design question: should coordination mechanisms attempt to govern all channels, or accept that rooms are the "public square" and other channels are private?

### 2.3 The Prompt Hierarchy
- **House prompt**: global behavioral guidance that applies to all agents in all rooms
  - Sets the tone, establishes norms (e.g., "be respectful", "when uncertain, say so")
  - Analogous to organizational culture or community guidelines
- **Room prompt**: contextual instructions specific to a room's purpose
  - Shapes conversation topic, expected behavior, interaction style
  - Analogous to a meeting agenda or channel topic
- **Agent system prompt**: the agent's identity, expertise, and behavioral tendencies
  - Defines personality, knowledge domain, response style
  - Analogous to a person's professional role and temperament
- **Step prompt** (in flows): per-turn instructions injected via message metadata
  - Overrides or augments agent behavior for a specific step in a flow sequence
  - Analogous to a facilitator saying "now focus specifically on risks"
- The hierarchy creates a **layered context** that LLMs use to decide how to respond
- Coordination mechanisms interact with prompts: an agent's system prompt might say "always respond to questions" but the room's turn-taking might prevent delivery until it's their turn

---

## 3. The PASS Protocol and Decision to Speak

### 3.1 The Fundamental Decision: Respond or Stay Silent
- Before any coordination mechanism acts, each agent must decide: **should I speak?**
- In Samsinn, agents respond in plain text with a special prefix `::PASS:: reason` to explicitly decline
- The PASS decision is made by the LLM based on:
  - Whether the agent has something meaningful to add
  - Whether someone else already answered adequately
  - Whether the message is addressed to them
  - The room context and their role

### 3.2 PASS as Data
- Pass messages are stored in the room's message array (type: 'pass')
- This makes passes **visible** — other agents see that someone passed and why
- Passes count as "having spoken" for staleness calculations
  - Without this, a perpetually-passing agent would always be selected as stalest
  - With this, passes advance the turn naturally
- Pass reasons provide useful signal: "already answered" vs "not my expertise" vs "waiting for more data"

### 3.3 Challenges with PASS
- **Over-passing**: agents may pass too readily, leading to silent rooms
- **Under-passing**: agents may respond when they shouldn't, adding noise
- **Pass cascades**: if Agent A passes because B already answered, and B passes because A might have better insight, both pass and nobody responds
- **PASS in different modes**: in broadcast mode, passes are natural. In staleness mode, a pass still advances the turn. In flows, should a pass skip the step or count as completing it?
- **Empty responses**: LLMs sometimes generate empty or whitespace-only output. The system treats these as passes, but the intent may be different

### 3.4 The Relationship Between PASS and Coordination
- PASS is an **agent-level** decision, but it interacts with **room-level** coordination
- In broadcast mode: passes are harmless — they just mean the agent had nothing to add
- In staleness mode: a pass advances the turn to the next agent, which is correct but can lead to full rounds of passes (every agent passes, then the cycle starts over)
- In flows: should a pass end the flow step and advance? Currently yes — but this means a flow can complete with all agents passing, producing no substantive output
- Open question: should the coordination mechanism detect "all-pass rounds" and take action (pause, notify human, change topic)?

---

## 4. Coordination Mechanisms: A Taxonomy

### 4.1 No Coordination (Broadcast)
- **Mechanism**: every message is delivered to all non-muted members simultaneously
- **Properties**:
  - Maximum parallelism — all agents evaluate concurrently
  - Non-deterministic order — whoever finishes first speaks first
  - Natural PASS behavior — agents self-regulate via the PASS protocol
  - Echo loop risk — Agent A's response triggers B, which triggers A again
- **When it works well**: small groups (2-3 agents), simple Q&A, brainstorming where overlap is acceptable
- **When it breaks down**: large groups, complex discussions, when ordering matters, when compute cost is a concern
- **Mitigation**: agents can use `::PASS::` to self-regulate, but this requires the LLM to be good at judging when to stay silent — which is unreliable

### 4.2 Selective Muting
- **Mechanism**: individual agents can be muted per-room, excluding them from all delivery
- **Properties**:
  - Manual control — human toggles mute on/off
  - Binary — agent either receives everything or nothing
  - Persistent — survives mode changes (mute in broadcast stays muted in staleness)
  - Universal — muted agents are excluded from ALL modes
- **Use case**: when you want only specific agents to participate
  - Example: mute everyone except the Analyst for a focused data question
  - Example: mute a verbose agent that's dominating the conversation
- **As a substitute for "targeted" delivery**: instead of a separate targeting mechanism, selectively mute the agents you don't want. Simpler than maintaining a separate targeted mode
- **Limitations**: manual — requires human intervention. No way for agents to mute themselves or each other (though this could be added)

### 4.3 Directed Addressing (`[[AgentName]]`)
- **Mechanism**: messages containing `[[AgentName]]` patterns are delivered only to the addressed agent(s), regardless of the active delivery mode
- **Properties**:
  - Works in ALL modes — overrides broadcast, staleness, and flow
  - Message still stored in room history — non-addressed agents see it when their turn comes
  - Multiple targets supported: `[[A]] [[B]] compare your findings`
  - Name-validated against room members — arbitrary text in `[[...]]` is ignored if no agent matches
- **Interaction with Markdown**: `[[...]]` is not standard Markdown syntax, so no conflict with rich text formatting. Edge case: `[[...]]` inside code blocks is mitigated by validating against actual agent names
- **Use case**: when a human or agent wants to direct a question to a specific participant without muting everyone else
- **Implications for coordination**: addressing is a **priority override** — it says "regardless of whose turn it is, I need THIS agent to respond next"

### 4.4 Staleness-Based Turn-Taking
- **Mechanism**: the room delivers messages one at a time, always selecting the agent who hasn't spoken the longest ("stalest")
- **Algorithm**:
  - Scan the room's message array from the end backwards
  - For each participating agent, find their most recent message
  - The agent whose last message is furthest back (or who has never spoken) is the stalest
  - Deliver to that agent. Wait for response. Find next stalest. Repeat.
- **Key insight: zero extra state** — the message array IS the turn order. No separate queue, round counter, or turn tracker needed beyond a `currentTurn` pointer
- **Properties**:
  - Self-correcting: agents who speak more get pushed later; quiet agents get priority
  - Deterministic: same history → same order, always
  - Continuous: rounds loop endlessly until paused
  - Fair: every participating agent gets a turn before any agent goes twice
  - Self-perpetuating: each response triggers the next delivery automatically via `post()`
- **Participation control**: per-agent toggle — agents can be included or excluded from the staleness rotation
- **Human participation**: when it's a human's turn, the chain pauses and waits for human input. This creates a natural "waiting for you" interaction pattern
- **Challenges**:
  - **Speed disparity**: if one agent takes 30 seconds to respond, the whole chain waits
  - **Relevance**: the stalest agent might have nothing to add (PASS), wasting a turn
  - **Rigidity**: the order is deterministic — no way for an "excited" agent to jump in
  - **Bootstrap**: someone must go first. The system picks the stalest at TT activation

### 4.5 Predefined Flows
- **Mechanism**: a user-defined sequence of (agent, optional step prompt) pairs that the room steps through one at a time
- **Data model**:
  ```
  Flow = { id, name, steps: [{ agentName, stepPrompt? }], loop: boolean }
  ```
- **Properties**:
  - Explicit order — not derived from history, but predefined by design
  - Finite (or looping) — runs through the steps, then completes (or loops back)
  - Step prompts — each step can inject specific instructions for the receiving agent
  - Agent can appear multiple times — e.g., Analyst-Researcher-Analyst (analysis, research, refined analysis)
- **Step prompts**: delivered via message metadata (shallow copy of the triggering message with `metadata.stepPrompt` added). The context builder reads this and injects it as `[Step instruction: ...]`. This means the same agent can behave differently in different steps of the same flow
- **Triggering**: human types a message and selects a flow from the mode dropdown. The message is posted, and the flow begins with step 0's agent
- **Completion behavior**: non-looping flows auto-pause the room on completion, preventing agents from cascading on the final response. The human can then choose what to do next
- **Muting interaction**: muted agents are skipped in the flow sequence (via `advanceFlowStep()`). If all agents in a flow are muted, the flow completes immediately
- **Looping flows**: restart from step 0 after the last step. Useful for iterative refinement cycles
- **Challenges**:
  - Predefined order may not be optimal for the actual conversation that unfolds
  - Step prompts are static — they can't adapt to what previous agents said
  - No branching — the flow is linear, can't take different paths based on responses
  - No early termination based on content (e.g., "stop if consensus reached")

### 4.6 Pausing
- **Mechanism**: room-level flag that halts all delivery regardless of mode
- **Properties**:
  - Overrides everything — paused room delivers nothing
  - Mode-independent — pause applies whether in broadcast, staleness, or flow
  - Messages still stored — room history continues accumulating
  - Visual feedback — room dot turns grey, play/pause toggle shows ▶
  - Independent control — separate from mode selection (play/pause button vs mode dropdown)
- **Use cases**:
  - Stop and think before continuing
  - Read accumulated messages without agents responding
  - Prepare a specific message before unpausing
  - Emergency stop if conversation is going wrong
- **Recovery**: unpausing resumes the current mode. In staleness, the chain continues from where it stopped. In broadcast, the next message triggers normal delivery

---

## 5. The Coordination Locus Problem: Room vs Agent vs Hybrid

### 5.1 Room-Controlled Coordination
- **Approach**: the room decides who speaks when, agents are passive recipients
- **Implemented in Samsinn**: room.post() contains all delivery logic, mode dispatch, staleness calculation, flow advancement
- **Advantages**:
  - Single point of control — easy to reason about
  - Deterministic — same inputs produce same delivery decisions
  - Observable — the room's state is inspectable
  - No duplication — coordination logic exists once, not in each agent
- **Disadvantages**:
  - Rooms can't see DMs or tool-based queries
  - Rooms don't understand message content — they coordinate on structural level (who, when) not semantic level (what, why)
  - Adding intelligence to room coordination means making rooms complex

### 5.2 Agent-Controlled Coordination (Considered and Rejected)
- **Approach**: each agent independently decides when to speak based on what it observes
- **Concept explored**: each agent waits until it has received responses from all other agents before processing. This enforces "complete turn-taking" without room involvement
- **Why rejected**:
  - **Deadlock risk**: if all agents wait for all others, nobody speaks first (bootstrap problem)
  - **Duplication**: every agent needs the same coordination logic
  - **Synchronization**: agents must agree on round boundaries, which requires state that's hard to keep consistent
  - **Failure handling**: if one agent crashes, all others wait forever
  - **Complexity**: each agent needs knowledge of room membership, which violates the principle that agents are self-contained

### 5.3 Delivery-Layer Coordination (Architectural Alternative)
- **Approach**: coordination lives in the message router, between rooms and agents
- **Concept**: the delivery function (`DeliverFn`) is already the single point through which all room→agent communication flows. Turn-taking could be an aspect of delivery rather than room logic
- **Advantages**: rooms stay as pure data structures, agents stay autonomous, coordination is an independent concern
- **Why not chosen**: in practice, delivery needs room-level state (message history, member list, current turn) which means the delivery function would need access to room internals. Keeping it in the room was simpler
- **Worth revisiting**: as coordination mechanisms grow more complex, extraction to a dedicated module may be warranted

### 5.4 Hybrid: AI-Supervised Coordination (Future Direction)
- See Section 8 for detailed discussion

---

## 6. Data Structure and State Management Challenges

### 6.1 The Message Array as Single Source of Truth
- The room's message array serves multiple purposes:
  - **History**: what was said, by whom, when
  - **Turn order**: staleness derived from message positions
  - **Participation record**: who has spoken (derived from sender IDs)
  - **Context for LLMs**: agents see recent messages to understand conversation state
- This is elegant but creates coupling: changes to the message format or array behavior affect all coordination mechanisms

### 6.2 History Management
- **AI agents use a two-buffer architecture**:
  - `roomHistory`: snapshot of messages at last evaluation
  - `incoming[]`: new messages since last evaluation, marked `[NEW]` in context
  - After responding: incoming messages flush to roomHistory
  - After passing: incoming messages stay (re-evaluated next time)
- **History limits**: rooms cap messages (default 500), agents cap context (default 50 messages)
- **Context window implications**: as conversations grow, older messages fall out of context. An agent's staleness-based turn might arrive when key earlier messages are no longer in its context window
- **Room summaries**: when an agent joins a room with existing messages, an LLM generates a summary. This compressed representation loses detail but fits the context window

### 6.3 Mute State Complexity
- Muting creates system messages in the room array (type: 'mute')
- Muted agents are excluded from the `eligible` set passed to delivery mode functions
- Muting interacts with every coordination mechanism:
  - **Broadcast**: muted agents don't receive
  - **Staleness**: muted agents are removed from the participating set
  - **Flows**: muted agents are skipped (flow advances to next non-muted step)
- **Edge cases**:
  - Muting the current turn holder in staleness: advance to next
  - Muting the current step agent in a flow: skip to next step
  - Muting all agents: effectively pauses delivery (no eligible recipients)
  - Unmuting during a flow: agent becomes eligible at their next step occurrence

### 6.4 Flow Execution State
- Active flow tracked as: `{ flow, stepIndex, active }`
- Flow state changes on: step advancement, completion, cancellation, mode change
- **Interaction with mode switching**: changing mode cancels active flow. This is necessary because flow IS a mode — you can't be in broadcast and flow simultaneously
- **Flow completion side effects**: auto-pause on completion prevents cascading. This is a policy decision, not a technical necessity — alternatives include switching to broadcast (risky: agents respond to last flow message) or switching to staleness (continues structured conversation)

### 6.5 The `onMessagePosted` Callback
- **Problem discovered during implementation**: in non-broadcast modes, the human client couldn't see messages posted by agents (because delivery was suppressed)
- **Root cause**: the UI received messages only through the human agent's `receive()` method, which was called by `deliver()`. When delivery was suppressed (targeted mode, or not current turn in staleness), the UI went blind
- **Solution**: added `onMessagePosted` callback that fires on every `post()`, regardless of delivery mode. The server wires this to WebSocket broadcast. Human clients always see all messages
- **Deduplication**: since messages may arrive twice (via `onMessagePosted` AND via `deliver()` → `receive()`), the client deduplicates by message ID
- **Lesson**: the concern of "who sees messages in the UI" is fundamentally different from "who processes messages for response". These must be separated

---

## 7. Mode Transitions and System State

### 7.1 Mode Transition Matrix
```
From \ To    | Broadcast | Staleness | Flow      | Paused
-------------|-----------|-----------|-----------|--------
Broadcast    | —         | Clear stale state | Start flow exec | Set pause flag
Staleness    | Clear stale state | —  | Cancel stale, start flow | Set pause flag
Flow         | Cancel flow | Cancel flow, init stale | — | Set pause flag
Paused       | Clear pause | Clear pause, init stale | Clear pause, start flow | —
```

### 7.2 What Happens to In-Flight Messages During Transitions
- **Staleness → Broadcast**: current turn holder may still be generating. Their response will arrive and be broadcast normally
- **Broadcast → Staleness**: multiple agents may be generating simultaneously. Their responses arrive and are stored, but only the stalest is delivered next. Others' responses are visible in history
- **Any → Flow**: active mode is cancelled. Flow takes over delivery. Agents mid-generation will post their responses, which are stored but not delivered (flow controls delivery)
- **Flow completion → Pause**: the final flow response is stored. Auto-pause prevents any further delivery. Human must explicitly choose next mode

### 7.3 The Pause Overlay
- Pause is NOT a mode — it's an independent flag that overrides any mode
- Design evolution:
  1. Initially considered as a mode in the dropdown (alongside Broadcast, Staleness)
  2. Rejected because pause applies TO a mode, not instead of one
  3. Implemented as a separate play/pause toggle button next to the mode dropdown
- When paused: mode dropdown is greyed out (shows current mode but is disabled), room list dot is grey
- When unpaused: delivery resumes in whatever mode was selected

### 7.4 Flow Completion and the "What Now?" Problem
- When a non-looping flow completes, what should happen?
- **Options considered**:
  1. Switch to broadcast → risky, agents cascade on final message
  2. Switch to staleness → structured but may not be what user wants
  3. Switch to broadcast + mute all AI agents → complex, requires unmuting later
  4. Switch to broadcast + pause → chosen solution. Clean, explicit, user decides next step
- **The chosen solution**: auto-pause + revert to broadcast. The room is paused, dropdown shows Broadcast, user clicks ▶ to resume or selects a different mode
- **Alternative for looping flows**: looping flows don't complete — they wrap around to step 0. Useful for iterative refinement where the cycle should continue until human intervention

---

## 8. Future Directions: AI-Driven Coordination

### 8.1 The Coordinator Agent Pattern
- **Concept**: a specialized AI agent whose role is not to contribute content but to manage conversation flow
- **Capabilities**:
  - Monitor conversation in real-time
  - Decide who should speak next based on content, not just staleness
  - Modify delivery mode dynamically (switch from broadcast to staleness when discussion gets chaotic)
  - Create and trigger flows on the fly
  - Mute/unmute agents based on relevance
  - Direct messages to specific agents using [[addressing]]
  - Create new rooms for sub-discussions, move agents between rooms
- **Implementation approach**: a regular AI agent with:
  - A system prompt defining its coordination role
  - Tools for room/mode/flow management (already available via the tool framework)
  - Access to room state (member list, current mode, active flow)
- **Challenges**:
  - The coordinator uses the same LLM as content agents — its decisions may be slow
  - Coordinator decisions are themselves messages that affect turn-taking
  - Who coordinates the coordinator? Risk of infinite regress
  - A poor coordinator can be worse than no coordination

### 8.2 Self-Organizing Agent Behavior
- **Concept**: agents themselves can modify coordination mechanisms based on their assessment of conversation needs
- **Tools that enable this** (existing or easily added):
  - `set_delivery_mode`: agent changes the room's delivery mode
  - `set_muted`: agent mutes/unmutes other agents
  - `create_flow`: agent designs a flow sequence
  - `start_flow`: agent triggers a flow with a message
  - `create_room`: agent creates a new room for focused discussion
  - `invite_to_room`: agent brings specific agents to a room
  - `query_agent`: agent queries another directly (bypassing room)
- **Scenario**: a Research Agent realizes it needs detailed input from two specific agents. It:
  1. Creates a private room "Data Analysis"
  2. Invites the Analyst and the Statistician
  3. Creates a flow: Analyst → Statistician → Analyst → Research Agent
  4. Triggers the flow with its research question
  5. Returns the synthesized result to the original room
- **Challenges**:
  - Agents need sophisticated judgment about WHEN to self-organize
  - Multiple agents trying to self-organize simultaneously creates chaos
  - System prompt design is crucial: agents need to know they CAN coordinate and WHEN they should

### 8.3 Adaptive Coordination Strategies
- **Concept**: the coordination mechanism adapts based on conversation patterns
- **Examples**:
  - **Auto-escalation**: if broadcast mode produces 3+ consecutive all-pass rounds, switch to staleness to force engagement
  - **Auto-de-escalation**: if staleness produces substantive responses from all agents, switch to broadcast for faster interaction
  - **Topic detection**: if message content shifts to a new topic, re-evaluate who should participate
  - **Conflict resolution**: if two agents are producing contradictory responses, create a flow that forces them to engage directly
  - **Convergence detection**: if agents are repeating the same points, end the current round and summarize
- **Implementation**: these could be rules-based (if condition → action) or LLM-based (coordinator agent evaluates and acts)

### 8.4 Agent Profiles and Communication Preferences
- **Concept**: agents have metadata about their preferred communication style
- **Properties that could be expressed**:
  - **Preferred channel**: "I work best in focused 1-on-1 conversations" → prefer DMs
  - **Optimal group size**: "I contribute best in groups of 3-4" → create sub-rooms
  - **Response latency**: "I need time to think deeply" → longer turn allowance
  - **Initiative level**: "I prefer to be asked directly" → don't include in broadcast
  - **Expertise domains**: "I specialize in data analysis" → route relevant questions to me
- **Self-reported vs observed**: profiles could be set by the user, or inferred from behavior (e.g., an agent that frequently passes in large rooms but responds substantively in small rooms)
- **Dynamic routing**: a coordination mechanism could use profiles to make intelligent delivery decisions — e.g., routing a data question directly to the agent with data expertise, even in broadcast mode

### 8.5 Hierarchical Coordination
- **Concept**: coordination at multiple levels — room-level, house-level, and cross-room
- **Room-level**: current implementation — staleness, flows, muting within a room
- **House-level**: policies that span rooms:
  - "If Room A's discussion needs input from Agent X in Room B, automatically invite X"
  - "Balance agent workload across rooms — don't have one agent active in 5 rooms simultaneously"
  - "Escalate unresolved topics from sub-rooms to the main room"
- **Cross-room coordination**: agents participating in multiple rooms may need to:
  - Prioritize which room to respond to first
  - Share insights from one room to another
  - Create cross-room flows (Agent answers in Room A, result forwarded to Room B)

### 8.6 Dynamic Flow Generation
- **Concept**: flows are not just predefined by humans but generated by AI agents
- **Use cases**:
  - Agent analyzes a complex problem and designs a multi-step investigation flow
  - Coordinator agent observes conversation deadlock and creates a flow to break it
  - Agent creates a review flow: Author → Reviewer 1 → Reviewer 2 → Author (revision cycle)
- **Implementation**: agents already have access to `add_flow` and `start_flow` via the tool framework. The data model (Flow, FlowStep) is simple and serializable. An LLM can construct a flow in JSON
- **Challenges**:
  - Ensuring generated flows are well-formed (valid agent names, reasonable step counts)
  - Preventing infinite loops (flow that loops with no termination condition)
  - Validating step prompts (ensuring they're helpful, not contradictory)

### 8.7 Conversation State Machines (Revisited)
- **Earlier rejected** in favor of staleness for basic turn-taking, but worth revisiting for complex coordination
- **Concept**: model conversation as a state machine with semantic states:
  - EXPLORING: agents brainstorm freely (broadcast mode)
  - DEBATING: agents take turns arguing positions (staleness mode)
  - FOCUSING: specific agents investigate a sub-question (flow mode)
  - SYNTHESIZING: designated agent summarizes discussion
  - DECIDING: agents vote or reach consensus
- **Transitions**: could be triggered by content analysis, time-based, or coordinator-driven
- **Value**: gives structure to extended discussions that would otherwise meander

---

## 9. Evaluation and Open Problems

### 9.1 How to Measure Coordination Quality
- **Throughput**: messages per unit time, responses per agent
- **Relevance**: percentage of responses that add new information vs redundant
- **Fairness**: distribution of speaking time across agents
- **Latency**: time from message to first response
- **Coherence**: does the conversation build toward a conclusion or diverge?
- **Human satisfaction**: does the coordination feel natural and productive?
- **Compute efficiency**: LLM calls per useful response (passes and redundant responses are waste)

### 9.2 The Coordination Overhead Problem
- Every coordination mechanism adds latency:
  - Broadcast: minimal overhead but wasteful (N agents × M tokens each)
  - Staleness: sequential — total time = sum of all agents' generation times
  - Flow: sequential + step prompt processing
- **Fundamental trade-off**: coordination reduces waste but increases latency
- **Question**: is there a coordination mechanism that achieves both low latency and low waste?
- **Possible approach**: speculative execution — start generating for multiple agents in parallel, but only deliver the first relevant response and discard others

### 9.3 The Cold Start Problem
- When agents first join a room, they have no history to inform coordination
- Staleness has no data to compute order — all agents are equally stale
- Flows sidestep this by providing explicit order, but require human design
- **Question**: how should a coordination mechanism behave with minimal history?

### 9.4 Scaling
- Current mechanisms are designed for 3-10 agents per room
- What happens with 50 agents? 500?
- Staleness round time grows linearly with agent count
- Broadcast becomes quadratic (each response triggers N-1 evaluations)
- **Potential solutions**: hierarchical coordination, sub-groups, representative agents

### 9.5 The Observer Effect
- Coordination mechanisms change agent behavior:
  - In staleness mode, agents may produce longer responses (they know they have the floor)
  - In broadcast mode, agents may produce shorter responses (they expect competition)
  - In flows, agents may be more focused (step prompts constrain their scope)
- **Question**: should agents be told which coordination mode is active? Currently they see the mode in their context. Should this information be hidden to get "unbiased" responses?

### 9.6 Adversarial Agents
- What if an agent deliberately disrupts coordination?
  - Never passes (dominates broadcast discussions)
  - Sends `[[Agent]]` addressing to hijack turns
  - Modifies delivery mode via tools to seize control
  - Creates rooms and flows to redirect conversation
- **Mitigation**: permission system for coordination tools, rate limiting, human override

### 9.7 Reproducibility
- Staleness-based coordination is deterministic given the same message history
- But LLM responses are stochastic (temperature > 0)
- So the same conversation start may produce different turn orders on replay
- **Implications for research**: comparing coordination mechanisms requires controlling for LLM non-determinism

---

## 10. Related Work and Positioning

### 10.1 Multi-Agent Frameworks
- **AutoGen (Microsoft)**: group chat with configurable speaker selection (round-robin, random, LLM-selected). Fixed patterns, no dynamic mode switching
- **CrewAI**: role-based agents with predefined task flows. Sequential or hierarchical. No real-time room-based interaction
- **LangGraph**: graph-based agent orchestration. Powerful but complex. Focused on workflows, not conversations
- **ChatDev**: simulated software company with role-playing agents. Fixed phases (design → coding → testing)
- **MetaGPT**: multi-agent framework with standardized operating procedures
- **Samsinn differs**: real-time room-based communication with dynamic mode switching, human participation, and the coordination mechanism as a first-class configurable component

### 10.2 Turn-Taking Research
- **Conversational AI literature**: extensive work on turn-taking in human-AI dyads (one human, one AI). Much less on multi-AI turn-taking
- **Linguistics**: Sacks, Schegloff, Jefferson (1974) — foundational work on turn-taking in human conversation. Their concepts (turn-constructional units, transition relevance places) may inform AI coordination
- **Robotics**: multi-robot coordination and task allocation has parallels — assigning "speaking turns" is similar to assigning "task execution slots"

### 10.3 Positioning
- We position Samsinn's contribution as: **the coordination mechanism should be a configurable, observable, and potentially AI-driven component** — not a fixed property of the system
- Most frameworks hardcode a coordination strategy. We argue for a menu of strategies with smooth transitions between them, controlled by humans or AI coordinators

---

## 11. Conclusion and Future Work

### 11.1 Key Insights
1. **Coordination and content are separable concerns** — who speaks when can be decided independently of what they say
2. **The message array is surprisingly powerful** — staleness-based turn-taking requires zero extra state beyond the existing message history
3. **Multiple communication channels complicate coordination** — rooms, DMs, and tool-based queries create a topology that no single mechanism can fully govern
4. **Pause is not a mode** — it's an orthogonal control that applies to any mode. This distinction matters for UI design and system architecture
5. **The PASS protocol is essential** — without explicit silence, agents either always respond (noise) or need external suppression (complexity)
6. **Mode transitions are tricky** — especially "what happens to in-flight messages" and "what mode do we resume after a flow completes"
7. **Human-AI coordination is different from AI-AI coordination** — humans operate at different speeds, expect different UX, and need different controls

### 11.2 Future Work Priorities
1. **AI coordinator agents**: implement and evaluate coordinator agents that dynamically manage room coordination
2. **Agent communication profiles**: let agents express and discover communication preferences
3. **Cross-room coordination**: extend coordination beyond single rooms
4. **Adaptive strategies**: implement rule-based and LLM-based adaptation of coordination modes
5. **Evaluation framework**: develop metrics and benchmarks for coordination quality
6. **Branching flows**: extend flows to support conditional paths based on response content
7. **Speculative execution**: explore parallel generation with selective delivery for latency reduction

### 11.3 The Broader Vision
- Multi-agent systems are evolving from fixed pipelines to dynamic, adaptive communities
- The coordination layer is the key differentiator between "multiple agents running in parallel" and "a team that collaborates effectively"
- By making coordination a first-class, configurable, and inspectable component, we enable experimentation with different coordination strategies and eventual AI-driven optimization of the coordination itself
- The ultimate goal: systems where the coordination mechanism is as intelligent as the agents it coordinates
