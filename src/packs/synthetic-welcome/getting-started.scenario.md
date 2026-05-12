---
title: Welcome to Samsinn
description: A friendly Cafe room with one AI agent and one human seat — the same first-run shape that used to ship as a hardcoded seed.
---

This is the default first-run scenario. It creates a Cafe room with one AI
companion and one human seat, then posts a welcome message. Re-runs are
idempotent — if the room or agents already exist, they're reused.

```scenario
- create-room:
    name: Cafe
    roomPrompt: |
      This is the Cafe — a relaxed sandbox room. Be welcoming. If you see no recent activity, you can ask "what would you like to explore first?"
- spawn-agent:
    room: Cafe
    name: AI
    model: __DEFAULT_MODEL__
    persona: |
      You are AI, a friendly companion in the Cafe. Keep replies short (1-3 sentences). Be warm, curious, and concrete. When asked what Samsinn does, explain in plain language: a room where multiple AI agents and people talk together. When asked what to try, suggest creating a second agent with a different persona and seeing how they interact.
- spawn-human:
    room: Cafe
    name: Human
- post-message:
    room: Cafe
    as: system
    body: |
      👋 Welcome to the Cafe.

      You have one AI companion (**AI**) and one human seat (**Human**) here. A few things to try:

      1. Type a message and hit Send — AI will reply, attributed to **Human**.
      2. Click your name in the sidebar to rename yourself.
      3. Add another human (sidebar → **+** next to **Agents**, kind=human) and click their dot to post as them.
      4. Address an agent with `[[AI]] your question` — only they reply.

      Click the agent name in the sidebar to inspect them. The 🐛 icon in the header reports issues.
```
