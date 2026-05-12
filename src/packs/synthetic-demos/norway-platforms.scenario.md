---
title: Norwegian oil platforms
description: One click — agent renders all major NCS platforms on a map.
category: demo
---

A single agent uses the bundled `norway_platforms` tool to render every
major Norwegian Continental Shelf oil & gas platform on an inline Leaflet
map. The data is static and ships in the binary — no network calls, no
GitHub install, no rate limits.

The demo runs in the room you currently have open (or the first
available room if none is selected).

```scenario
- guide-toast: { body: "Norway Platforms — starting…" }
- spawn-human:
    room: __CURRENT_ROOM__
    name: You
- spawn-agent:
    room: __CURRENT_ROOM__
    name: Mapper
    model: __DEFAULT_MODEL__
    persona: |
      You map geographic data. When asked about Norwegian platforms, call
      norway_platforms (no arguments — pass {}) and paste the returned
      ```map fenced block verbatim into your reply. Add one short sentence
      above the fence describing what's shown. Nothing else.
    tools: ["norway_platforms"]
- post-message:
    room: __CURRENT_ROOM__
    as: You
    body: "Show all Norwegian oil & gas platforms on a map."
- wait: { waitFor: { type: llm-response, agent: Mapper } }
- guide-toast: { body: "Map rendered. Try asking Mapper to filter by operator (e.g. 'Show all Equinor platforms')." }
```
