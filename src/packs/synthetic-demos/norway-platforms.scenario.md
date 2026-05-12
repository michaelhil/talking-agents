---
title: Norwegian oil platforms
description: One click — agent renders all major NCS platforms on a map.
category: demo
---

A single agent uses the bundled `norway_platforms` tool to render every
major Norwegian Continental Shelf oil & gas platform on an inline Leaflet
map. The data is static and ships in the binary — no network calls, no
GitHub install, no rate limits. The demo runs end-to-end from this dialog.

If your default model is `gpt-5.4` (and you have an OpenAI key configured),
the demo runs on that. Otherwise it uses whatever default your providers
panel currently resolves to.

```scenario
- guide-toast: { body: "Norway Platforms — starting…" }
- create-room: { name: "NCS Platforms" }
- post-message:
    room: NCS Platforms
    as: system
    body: |
      Demo will use the default model (__DEFAULT_MODEL__). Tool calls go through
      the agent below.
- spawn-agent:
    room: NCS Platforms
    name: Mapper
    model: __DEFAULT_MODEL__
    persona: |
      You map geographic data. When asked about Norwegian platforms, call
      norway_platforms (no arguments) and paste the returned ```map fenced
      block verbatim into your reply. Add one short sentence above the
      fence describing what's shown — nothing else.
    tools: ["norway_platforms"]
- post-message:
    room: NCS Platforms
    as: system
    body: "Show all Norwegian oil & gas platforms on a map."
- wait: { waitFor: { type: llm-response, agent: Mapper } }
- guide-toast: { body: "Map rendered. Try editing the prompt to filter by operator (e.g. 'Show all Equinor platforms')." }
```
