# Planning, Todos, and Collaborative Task Management in Multi-Agent Systems

## Research Survey: How Planning Works in LLM Systems Today

### 1. ReAct Loop (Implicit Planning)
The agent thinks, acts, observes, and adjusts in a loop. No explicit plan object — the "plan" is implicit in the conversation context. Each step is decided based on the current state.
- **Pros**: Adaptive, handles unexpected situations well
- **Cons**: No visibility into what's coming, hard to coordinate with other agents
- **Used by**: Claude Code, most single-agent systems

### 2. Plan-and-Execute (Explicit Planning)
First decompose the task into steps, get approval, then execute sequentially. The plan is an explicit artifact.
- **Pros**: Predictable, reviewable, can be modified before execution
- **Cons**: Rigid, doesn't adapt well to discoveries mid-execution
- **Used by**: Claude Code plan mode, LangChain Plan-and-Execute

### 3. Tree of Thought
Generate multiple approaches at each step, evaluate each, pursue the most promising. The plan is a tree structure.
- **Pros**: Explores alternatives, finds better solutions
- **Cons**: Expensive (many LLM calls), hard to parallelize across agents

### 4. ReAcTree (Hierarchical, 2025)
Combines ReAct with tree-structured task decomposition. Each node is an agent responsible for a subgoal. If a task is too complex, the agent spawns child nodes — recursive decomposition.
- **Source**: https://arxiv.org/abs/2511.02424
- **Relevance to samsinn**: Agents could create sub-rooms with sub-flows for complex tasks

### 5. Blackboard Architecture (Re-emerging for LLMs, 2025-2026)
A shared workspace where agents read/write problem state, partial solutions, hypotheses. No direct agent-to-agent communication — everything goes through the blackboard. A control unit selects which agent acts next.
- **Source**: https://arxiv.org/html/2507.01701v1
- **Relevance to samsinn**: Rooms already function as shared workspaces. Adding structured artifacts (todos, plans) makes them blackboards.

### 6. Multi-Agent Collaboration Patterns
Frameworks like CrewAI, AutoGen, LangChain use a Planner Agent that decomposes tasks and assigns to specialized executor agents. Planning is centralized.
- **Source**: https://www.ibm.com/think/topics/multi-agent-collaboration
- **Gap**: Agents don't negotiate or co-evolve plans. One plans, others execute.

### 7. Collaborative Memory
Recent work on shared memory with access control: private memory (per-agent) and shared memory (selectively shared). Agents decide what to share.
- **Source**: https://arxiv.org/html/2505.18279v1
- **Relevance to samsinn**: DMs = private memory, rooms = shared memory. Already have the infrastructure.

---

## What Existing Systems Don't Do Well

1. **Collaborative planning** — planning is always centralized (one planner, many executors)
2. **Plan negotiation** — agents can't debate, modify, or reject plan steps
3. **Dynamic plan evolution** — plans are static once created, can't adapt during execution
4. **Cross-agent awareness** — agents don't know what other agents are planning or doing
5. **Mixed human-AI planning** — humans are either fully in control or fully out of the loop

---

## Samsinn's Unique Position

Samsinn already has infrastructure that maps directly to collaborative planning:

| Samsinn Feature | Planning Analog |
|----------------|-----------------|
| Rooms | Shared workspaces / blackboards |
| Flows | Executable plans (ordered sequences) |
| Message history | Shared context / working memory |
| DMs | Private negotiation channels |
| Muting | Selective attention / focus control |
| [[Addressing]] | Directed queries to specific experts |
| Room prompts | Behavioral constraints on the workspace |
| Agent tools | Ability to create rooms, flows, modify state |

No existing framework combines all of these.

---

## Ideas for Samsinn

### Idea 1: Plans as First-Class Room Objects

A **Plan** is a new data structure attached to a room — visible to all members, editable by any agent or human. Not just a list of steps, but a living document that evolves.

```
Plan: "Research competitive landscape"
├── Step 1: Analyst — Identify top 5 competitors [in progress]
├── Step 2: Researcher — Gather financials for each [blocked on Step 1]
├── Step 3: Writer — Draft comparison report [depends on Step 2]
└── Step 4: Analyst + Writer — Review and finalize [depends on Step 3]
```

Key difference from existing systems: any agent can propose modifications. The room prompt specifies who has authority to approve changes.

### Idea 2: The Blackboard Room

A room where the primary artifact is not conversation but a **shared structured workspace**. Agents contribute structured content (findings, hypotheses, partial solutions) to sections. The room prompt defines the workspace structure.

Agents can:
- Add findings to specific sections
- Challenge other agents' claims
- Mark items as verified/disputed
- Propose structural reorganizations

This is the LLM Blackboard Architecture applied to samsinn, with flow/muting/addressing controls layering on top.

### Idea 3: Self-Organizing Flows (Plan → Flow Pipeline)

Agents can **generate flows from plans**:

1. Human posts a goal: "Write a market analysis report"
2. A Planner agent decomposes it into steps
3. The Planner calls `create_flow()` with the sequence
4. The flow executes
5. If an agent discovers the plan needs adjustment, they call `modify_flow()` or create a new flow
6. The plan/flow evolves during execution

This makes flows dynamic. The planner could create sub-rooms with sub-flows for complex tasks — recursive decomposition.

### Idea 4: Shared Todo as a Room Artifact (Recommended Starting Point)

The simplest, most practical version: a **todo list** attached to a room. Any agent can add, complete, or modify items. The todo is visible in the UI alongside the chat. Agents reference it in their messages.

```typescript
interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  assignee?: string  // agent name
  dependencies?: string[]  // other todo IDs
  createdBy: string
  updatedBy?: string
  createdAt: number
  updatedAt: number
}
```

Agents get the todo list as context in the system prompt. When an agent marks something complete, others see it immediately.

**Why start here**: It's the foundation for all the more advanced ideas. Once agents can read/write a shared todo, we can layer on plan negotiation, auto-flow-generation, and coordinator agents.

### Idea 5: The Meta-Coordinator Agent

A special agent role that doesn't do domain work — it watches the conversation and orchestrates:
- Detects when agents are going in circles
- Proposes plan adjustments
- Changes delivery mode dynamically
- Mutes agents that aren't contributing
- Creates sub-rooms for side discussions
- Generates flows from observed conversation patterns

Uses the same tools any agent can use, but prompted to focus on orchestration.

### Idea 6: Plan Negotiation Protocol

When a plan is proposed, agents vote or comment before execution:

1. Planner proposes a plan (structured message)
2. Room enters a "negotiation flow" — each agent reviews
3. Agents approve, suggest modifications, or raise concerns
4. When consensus is reached, the plan becomes a flow
5. The negotiation transcript is part of room history — full provenance

### Idea 7: Agent Self-Organization

Agents can:
- Create rooms for sub-tasks they identify
- Invite specific agents to those rooms
- Set up flows for the sub-task
- Report results back to the parent room
- Modify their own communication patterns (e.g., switch to DMs for detailed technical discussion, then report conclusions in the room)

---

## What's Truly Novel

Existing systems: **static plans executed by obedient workers**.

Samsinn could have: **living plans that agents negotiate, evolve, and self-organize around**.

The combination of rooms (shared context), flows (executable plans), DMs (private negotiation), muting (attention control), addressing (directed queries), and agent autonomy (create rooms, flows, modify plans) creates something no existing framework offers: **a system where the planning IS the conversation, and the conversation IS the execution**.

---

## Implementation Roadmap

1. **Shared Todos** — room-level todo list, agent tools to manage, UI panel, context injection
2. **Plan from Todo** — tool to generate a flow from a todo list (assign agents to items, create sequence)
3. **AI-Initiated Flows** — agents can call create_flow/start_flow tools
4. **Coordinator Agent** — specialized prompt for orchestration, uses existing tools
5. **Plan Negotiation** — structured message type for proposals, voting mechanism
6. **Blackboard Rooms** — structured workspace with sections and claims
7. **Recursive Decomposition** — agents creating sub-rooms with sub-tasks

Each step builds on the previous. Step 1 (Shared Todos) is the foundation.

---

## References

- ReAcTree: Hierarchical Task Planning — https://arxiv.org/abs/2511.02424
- LLM Blackboard Architecture — https://arxiv.org/html/2507.01701v1
- Collaborative Memory in Multi-Agent Systems — https://arxiv.org/html/2505.18279v1
- Multi-Agent Collaboration (IBM) — https://www.ibm.com/think/topics/multi-agent-collaboration
- Agent-Oriented Planning — https://openreview.net/forum?id=EqcLAU6gyU
- Task Decomposition Patterns — https://www.agentpatterns.tech/en/agent-patterns/task-decomposition-agent
- Blackboard Architecture for Problem Solving — https://notes.muthu.co/2025/10/collaborative-problem-solving-in-multi-agent-systems-with-the-blackboard-architecture/
- GoalAct: Global Planning + Hierarchical Execution — https://arxiv.org/abs/2504.16563
- Modular Agentic Planner (MAP) — https://openreview.net/forum?id=iNcEChuYXD
