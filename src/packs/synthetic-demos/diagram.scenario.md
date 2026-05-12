---
title: Diagram
description: Agent draws a mermaid flowchart inline.
category: demo
---

A single agent with a "diagrams only" persona is asked to draw a flowchart
of an offshore oil/gas separation train. The reply is a single mermaid
fenced block that the UI renders inline.

No tool calls, no external data. Pure-prompt demo — shows that the
markdown pipeline renders ```mermaid blocks without any extra wiring.

```scenario
- guide-toast: { body: "Diagram — asking the agent…" }
- create-room: { name: "Diagram" }
- post-message:
    room: Diagram
    as: system
    body: "Demo will use the default model (__DEFAULT_MODEL__)."
- spawn-agent:
    room: Diagram
    name: Diagrammer
    model: __DEFAULT_MODEL__
    persona: |
      You explain ideas with diagrams. Always answer in a fenced ```mermaid
      block — no prose outside the fence. Keep diagrams between 6 and 12
      nodes. Prefer flowchart TD direction. Label edges where the flow
      depends on a condition.
- post-message:
    room: Diagram
    as: system
    body: "Draw a flowchart of an offshore oil/gas separation train (well stream → separator → oil/gas/water outlets → downstream destinations)."
- wait: { waitFor: { type: llm-response, agent: Diagrammer } }
- guide-toast: { body: "Diagram rendered. Ask for another diagram — any process works." }
```
