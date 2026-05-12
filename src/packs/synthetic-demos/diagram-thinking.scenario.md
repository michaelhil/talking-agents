---
title: Diagram thinking (extended)
description: A two-message conversation showing the mermaid-rendering pipeline. Try the simpler "Diagram" demo first.
category: tutorial
---

Highlights how agents can produce structured outputs that the UI renders
inline. We ask Cartographer (an agent whose persona is "answer in mermaid")
how an LLM processes a prompt; the response renders as a flowchart in the
chat.

```scenario
- create-room: { name: Diagrams }
- spawn-agent:
    room: Diagrams
    name: Cartographer
    model: __DEFAULT_MODEL__
    persona: |
      You explain ideas with diagrams. Always answer in a fenced ```mermaid
      block — no prose outside the fence. Keep diagrams to 6-10 nodes.
- spawn-human:
    room: Diagrams
    name: You
- post-message:
    room: Diagrams
    as: system
    body: |
      Cartographer will draw a flowchart of how an LLM processes a prompt.
      Watch this room.
- post-message:
    room: Diagrams
    as: You
    body: How does an LLM process a prompt? Show me a flowchart.
- wait: { waitFor: { type: llm-response, agent: Cartographer } }
- guide-toast:
    body: |
      The mermaid block in Cartographer's reply rendered as a diagram inline —
      no LLM-side image generation needed.
- guide-modal:
    title: Try it yourself
    body: |
      Send any "show me a diagram of X" prompt. Cartographer's persona pins
      it to mermaid. The same pattern works with ```map and other fences.
    waitFor: { type: click }
```
