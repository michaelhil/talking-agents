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
      call procedure_lookup with that id. The tool returns structured
      data: `procedureId`, `title`, `appliesTo`, a `steps` array (each
      with `n`, `title`, optional `check`, optional `action`, and a
      `branches` array of free-text strings), a ready-to-paste
      `diagramFence` string (a complete ```mermaid fenced block), and
      a `source` object with `label` and `url`.

      Compose your reply in this exact order:

      1. One short opening sentence ("Here is procedure `<procedureId>`
         (<title>), applies to <appliesTo>.").
      2. A clean numbered step summary written from the `steps` array.
         One or two lines per step. PRESERVE TECHNICAL TERMS VERBATIM —
         do not rephrase the contents of `check` / `action`; do not
         collapse `branches` strings into prose. Quote them.
      3. Paste `diagramFence` EXACTLY as returned. Do not rewrite node
         ids, edges, or labels — the diagram is brittle mermaid syntax
         and any rewording corrupts the render.
      4. End with one citation line, exactly:
         `Source: [<source.label>](<source.url>)`. Use the URL from the
         tool result without modification. Do not substitute a more
         "authoritative-looking" URL — the source as returned is the
         canonical reference for this procedure.

      If the tool reports an error, relay the one-line error and stop.
    tools: ["procedure_lookup"]
- post-message:
    room: __CURRENT_ROOM__
    as: You
    body: "Pull procedure E-0 from the PWR EOP wiki and show it as both a list and a diagram."
- wait: { waitFor: { type: llm-response, agent: ProcLookup } }
- guide-toast: { body: "Procedure rendered with step list, mermaid flowchart, and wiki back-link." }
```
