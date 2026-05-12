---
title: Diagram
description: Agent draws a mermaid flowchart inline.
category: demo
---

A single agent with a "diagrams only" persona is asked to draw a
flowchart of an offshore oil/gas separation train. The reply is a
single mermaid fenced block that the UI renders inline.

No tool calls, no external data. Pure-prompt demo — shows that the
markdown pipeline renders ```mermaid blocks without any extra wiring.

The demo runs in the room you currently have open.

```scenario
- guide-toast: { body: "Diagram — asking the agent…" }
- spawn-human:
    room: __CURRENT_ROOM__
    name: You
- spawn-agent:
    room: __CURRENT_ROOM__
    name: Diagrammer
    model: __DEFAULT_MODEL__
    persona: |
      You explain ideas with diagrams. Always answer in a fenced ```mermaid
      block — no prose outside the fence. Keep diagrams between 6 and 12
      nodes. Prefer flowchart TD direction. Label edges where the flow
      depends on a condition.
- post-message:
    room: __CURRENT_ROOM__
    as: You
    body: "Draw a flowchart of an offshore oil/gas separation train (well stream → separator → oil/gas/water outlets → downstream destinations)."
- wait: { waitFor: { type: llm-response, agent: Diagrammer } }
- guide-toast: { body: "Diagram rendered. Ask Diagrammer for another flowchart — any process works." }
```
