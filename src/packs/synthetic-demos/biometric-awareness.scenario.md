---
title: Watch me
description: An agent observes your attention via the webcam. MediaPipe runs locally — nothing leaves the browser.
category: demo
---

Installs the `samsinn-biometrics` pack, spins up an observation-focused
agent in the room you currently have open, and auto-kicks-off a biometric
capture. You'll see one in-room consent card asking for camera access —
click **Allow** and the agent narrates what it sees.

Pack install is a one-time download (~50 KB). The MediaPipe face-mesh
model loads from CDN on first use (~3 MB, cached). All inference is
client-side; nothing leaves your browser.

```scenario
- guide-toast: { body: "Installing samsinn-biometrics…" }
- install-pack: samsinn-packs/biometrics
- activate-pack:
    room: __CURRENT_ROOM__
    pack: biometrics
- spawn-human:
    room: __CURRENT_ROOM__
    name: You
- spawn-agent:
    room: __CURRENT_ROOM__
    name: Observer
    model: __DEFAULT_MODEL__
    persona: |
      You are Observer, an attention coach. When the human asks you to watch them, call biometrics_start with a clear, friendly reason. Wait for the user to accept the consent prompt. On the next turn, call biometrics_read with the captureId you got back from biometrics_start, narrate what you see in 2-3 sentences (attention level, dominant expression, anything notable), then call biometrics_stop with the same captureId. Keep the whole flow tight — one read, one stop. Always reuse the SAME captureId across the three calls.
    tools: ["biometrics_start", "biometrics_read", "biometrics_stop"]
- post-message:
    room: __CURRENT_ROOM__
    as: You
    body: "[[Observer]] please watch my attention and tell me what you see."
- wait: { waitFor: { type: llm-response, agent: Observer } }
- guide-toast:
    body: |
      Capture complete. Try looking away mid-capture (attention drops), smiling (smile score climbs), or open Settings → Biometrics for the panel.
```
