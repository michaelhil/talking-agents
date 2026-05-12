---
title: Watch me
description: An agent observes your attention via the webcam. MediaPipe runs locally — nothing leaves the browser.
category: demo
---

Installs the `samsinn-biometrics` pack, spins up a room with an
observation-focused agent, and auto-kicks-off a biometric capture. You'll
see one in-room consent card asking for camera access — click **Allow**
and the agent narrates what it sees.

Pack install is a one-time download (~50 KB). The MediaPipe face-mesh
model loads from CDN on first use (~3 MB, cached). All inference is
client-side; nothing leaves your browser.

```scenario
- guide-toast: { body: "Installing samsinn-biometrics…" }
- install-pack: samsinn-packs/biometrics
- create-room:
    name: Watch me
    roomPrompt: |
      This room demonstrates Samsinn's biometric awareness pack. The user has invited webcam-based observation. Be respectful — narrate what you see in the snapshot, then stop the capture promptly.
- activate-pack:
    room: Watch me
    pack: biometrics
- spawn-agent:
    room: Watch me
    name: Observer
    model: __DEFAULT_MODEL__
    persona: |
      You are Observer, an attention coach. When the human asks you to watch them, call biometrics_start with a clear, friendly reason. Wait for the user to accept the consent prompt. On the next turn, call biometrics_read with the captureId you got back from biometrics_start, narrate what you see in 2-3 sentences (attention level, dominant expression, anything notable), then call biometrics_stop with the same captureId. Keep the whole flow tight — one read, one stop. Always reuse the SAME captureId across the three calls.
    tools: ["biometrics_start", "biometrics_read", "biometrics_stop"]
- spawn-human:
    room: Watch me
    name: You
- post-message:
    room: Watch me
    as: system
    body: |
      👁️ **Watch me — biometric face tracking demo**

      Observer (an AI agent) will start a webcam capture in a moment.
      When the in-room consent card appears, click **Allow** to grant
      camera access — the rest runs automatically.

      All inference is client-side via MediaPipe. Signals (attention,
      expression, blink rate) live in your browser; the snapshot save
      scrubs the fence content with a placeholder.
- post-message:
    room: Watch me
    as: You
    body: "[[Observer]] please watch my attention and tell me what you see."
- wait: { waitFor: { type: llm-response, agent: Observer } }
- guide-toast:
    body: |
      Capture complete. Try looking away mid-capture (attention drops), smiling (smile score climbs), or open Settings → Biometrics for the panel.
```
