---
title: VATSIM into Heathrow
description: Live VATSIM arrivals to London Heathrow on a map.
category: demo
---

The agent calls the bundled `vatsim_arrivals` tool with ICAO `EGLL` and
renders every live VATSIM pilot whose filed flight plan terminates at
London Heathrow.

This demo makes one HTTPS call to `data.vatsim.net` (the public datafeed,
no API key required). If VATSIM is unreachable the agent will say so and
stop — no opaque errors.

The demo runs in the room you currently have open.

```scenario
- guide-toast: { body: "VATSIM Heathrow — fetching live feed…" }
- spawn-human:
    room: __CURRENT_ROOM__
    name: You
- spawn-agent:
    room: __CURRENT_ROOM__
    name: ATC
    model: __DEFAULT_MODEL__
    persona: |
      You query live VATSIM traffic. When asked about arrivals to an
      airport, call vatsim_arrivals with the ICAO code and paste the
      returned ```map fenced block verbatim into your reply. Add one
      short sentence above the fence summarizing how many aircraft are
      inbound. If the tool returns an error, relay that one sentence
      and stop.
    tools: ["vatsim_arrivals"]
- post-message:
    room: __CURRENT_ROOM__
    as: You
    body: "Show all VATSIM traffic arriving into London Heathrow (EGLL)."
- wait: { waitFor: { type: llm-response, agent: ATC } }
- guide-toast: { body: "Live feed rendered. Ask ATC about another airport (e.g. 'Show arrivals to KJFK')." }
```
