---
title: Biometric awareness
description: An agent observes your attention via the webcam. MediaPipe runs locally — nothing leaves the browser. Consent-gated per capture.
---

Installs the `samsinn-biometrics` pack, spins up a room with an
observation-focused agent, and walks the user through the consent →
active → stopped lifecycle of an inline biometric capture. The agent
sees the live signal stream (attention, expression, blink rate) via
the `biometrics_read` tool and reports what it observes.

Requires consent for one pack install (`samsinn-packs/biometrics`)
and one webcam permission grant in the browser.

```scenario
- install-pack: samsinn-packs/biometrics
- create-room:
    name: Biometric demo
    roomPrompt: |
      This room demonstrates Samsinn's biometric awareness pack. The user has invited webcam-based observation. Be respectful — narrate what you see in the snapshot, then stop the capture promptly.
- activate-pack:
    room: Biometric demo
    pack: biometrics
- spawn-agent:
    room: Biometric demo
    name: Observer
    model: __DEFAULT_MODEL__
    persona: |
      You are Observer, an attention coach. When the human asks you to watch them, call biometrics_start with a clear, friendly reason. Wait for the user to accept the consent prompt. On the next turn, call biometrics_read with the captureId you got back from biometrics_start, narrate what you see in 2-3 sentences (attention level, dominant expression, anything notable), then call biometrics_stop with the same captureId. Keep the whole flow tight — one read, one stop. Always reuse the SAME captureId across the three calls.
- spawn-human:
    room: Biometric demo
    name: You
- post-message:
    room: Biometric demo
    as: system
    body: |
      👁️ **Biometric awareness demo**

      Observer (an AI agent) is set up to watch your attention via the webcam.

      How this works:

      1. Ask Observer to watch you — they'll call `biometrics_start` which posts a consent card into this room.
      2. Click **Allow** on the consent card. Your browser prompts for camera access (one-time per origin).
      3. MediaPipe loads from CDN (~3 MB, cached after first use), then face-mesh inference begins. Live attention / expression / blink signals appear in the widget.
      4. Observer calls `biometrics_read` to see the same signals you do, and tells you what they observe.
      5. Observer calls `biometrics_stop`. The camera light goes out and the widget freezes on the final snapshot.

      Nothing leaves your browser — all inference is client-side. The capture's signals are ephemeral; the snapshot save scrubs the fence content with a `[biometric capture — not persisted]` placeholder.

      Type your request below to begin.
- guide-tooltip:
    selector: "textarea"
    body: |
      Ask Observer to watch you. Something like:
      `[[Observer]] please watch my attention and tell me what you see`
      then send.
    waitFor: { type: post, room: "Biometric demo" }
- wait: { waitFor: { type: llm-response, agent: Observer } }
- guide-toast:
    body: |
      Observer just called biometrics_start — look for the consent card with Allow / Deny. Click Allow to begin.
- guide-modal:
    title: After the capture finishes
    body: |
      Observer will read one snapshot and then stop the capture automatically.
      You'll see two cards in chat: the live capture (transitions to a stopped summary on tear-down) and Observer's narrated observation.

      Things to try:

      - Look away from the camera mid-capture. Attention drops from ~90% to under 20%.
      - Smile broadly. The `smile` score climbs above 0.5.
      - Furrow your brow + squint. `concentration` rises.
      - Open **Settings → Biometrics** to see the panel: camera picker, configurable resolution (320×240 / 480×360 / 640×480), and a Test capture button that runs the same pipeline without an agent.

      The pack only adds three tools: `biometrics_start`, `biometrics_read`, `biometrics_stop`. They're per-room-activated, so other rooms in this instance are unaffected. Uninstall the pack from Settings → Packs to remove the tools and the panel — UI extension lifecycle handles the rest.
    waitFor: { type: click }
```
