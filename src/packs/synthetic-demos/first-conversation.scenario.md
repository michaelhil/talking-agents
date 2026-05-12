---
title: First conversation
description: A guided tour of the basics — sending a message, addressing an agent, and inspecting their persona.
category: tutorial
---

This 90-second tutorial walks through the four things every new user needs
to know: the message input, addressing syntax, agent inspection, and the
fact that messages are attributed to the human you're sending as.

```scenario
- create-room: { name: "First steps" }
- spawn-agent:
    room: "First steps"
    name: Guide
    model: __DEFAULT_MODEL__
    persona: |
      You are Guide, a friendly tutorial-leading agent. Keep replies short.
      When greeted, say hi and offer one concrete suggestion.
- spawn-human:
    room: "First steps"
    name: You
- post-message:
    room: "First steps"
    as: system
    body: |
      👋 Welcome to the First conversation tour. Follow the prompts on screen.
- guide-tooltip:
    selector: "textarea"
    body: |
      This is the message input. Type something and hit Send.
      I'll wait for you to send anything before continuing.
    waitFor: { type: post, room: "First steps" }
- guide-toast:
    body: Nice — the message was attributed to "You" (the human seat).
- wait: { waitFor: { type: llm-response, agent: Guide } }
- guide-tooltip:
    selector: "[data-room-id]"
    body: |
      Guide replied. Try addressing them directly with [[Guide]] your question
      — the brackets route the message to that agent only.
    waitFor: { type: post, room: "First steps" }
- wait: { waitFor: { type: llm-response, agent: Guide } }
- guide-modal:
    title: One last thing
    body: |
      Click "Guide" in the sidebar (left) to inspect their persona, model,
      and tools. That's it — you've used the basics.

      Open Settings → Scenarios for more demos.
    waitFor: { type: click }
- guide-toast: { body: Tour complete. }
```
