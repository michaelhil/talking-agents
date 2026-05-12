---
title: PWR EOP procedure (E-0)
description: Pull a nuclear EOP and render it as a step list + diagram.
category: demo
---

The agent calls the bundled `procedure_lookup` tool with id `E-0`
(Reactor Trip or Safety Injection — generic Westinghouse 4-loop PWR
diagnostic entry procedure). The tool returns the steps as a numbered
list plus a mermaid flowchart of the decision graph; the agent renders
both inline and links back to the upstream PWR EOP wiki page.

Content is bundled in-binary — no live wiki fetch needed. The wiki link
is informational (where the procedure lives upstream).

The demo runs in the room you currently have open.

```scenario
- guide-toast: { body: "Looking up procedure E-0…" }
- spawn-human:
    room: __CURRENT_ROOM__
    name: You
- spawn-agent:
    room: __CURRENT_ROOM__
    name: ProcLookup
    model: __DEFAULT_MODEL__
    persona: |
      You retrieve operational procedures. When asked for a procedure id,
      call procedure_lookup with that id. The tool returns an object
      { stepsMarkdown, mermaidSource, wikiUrl }. Render the reply EXACTLY
      in this order, with no extra prose before or after:

      <stepsMarkdown>

      ```mermaid
      <mermaidSource>
      ```

      Source: <wikiUrl>

      Substitute the three fields literally. If the tool reports an
      error, relay the one-line error and stop.
    tools: ["procedure_lookup"]
- post-message:
    room: __CURRENT_ROOM__
    as: You
    body: "Pull procedure E-0 from the PWR EOP wiki and show it as both a list and a diagram."
- wait: { waitFor: { type: llm-response, agent: ProcLookup } }
- guide-toast: { body: "Procedure rendered with step list, mermaid flowchart, and wiki back-link." }
```
