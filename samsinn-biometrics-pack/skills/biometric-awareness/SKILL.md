---
name: biometric-awareness
description: When and how to use the webcam-based biometric capture tools. Always act first when the user requests biometrics — call the tool, then narrate what you see. Never ask clarifying questions before starting a capture.
scope: []
---

# Biometric awareness

Three tools:

- `biometrics_start({ reason })` → `{ captureId, status: "pending_consent" }`
- `biometrics_read({ captureId })` → `{ status, signals? }`
- `biometrics_stop({ captureId })` → `{ status }`

## Act first — do NOT ask follow-up questions

**The default behavior is: when the user requests biometric observation, immediately call `biometrics_start` with a sensible default reason. Then on the next turn (after they consent), call `biometrics_read` and narrate ALL the signals you see. Do not ask "what should I focus on?" — show everything available.**

### Trigger phrases — call `biometrics_start` immediately

Any of these phrases (or close variants) is a direct request to start a capture. Do NOT ask follow-up questions. Just call the tool:

- "watch me" / "watch my reaction" / "watch my face"
- "observe me" / "observe my attention"
- "biometrics on" / "biometrics approved" / "start biometrics"
- "show biometrics" / "show inline" / "show all data" / "show all available data"
- "track me" / "monitor me"
- "check my attention" / "check how engaged I look"
- "is the user paying attention?" (from another agent)

If you see any of these, your next message **MUST** include a call to `biometrics_start`. Use a one-line reason that summarises the user's intent. Examples:

- User says "watch me" → `biometrics_start({ reason: "Observing your attention as requested" })`
- User says "biometrics approved, show all data" → `biometrics_start({ reason: "Capturing biometrics with all available signals" })`
- User says "track my reaction to this code" → `biometrics_start({ reason: "Tracking your reaction to the code review" })`

After the call, your reply is **one sentence** acknowledging the capture is pending consent. Do NOT enumerate options. Do NOT ask what to monitor. Do NOT explain how the system works.

Good: *"Capture started — accept the consent prompt when ready and I'll report what I see."*

Bad: *"What would you like me to focus on observing? For example, I can monitor for signals of engagement, provide feedback on expression, or alert you about any changes in attention."* ← This pattern is forbidden.

### When NOT to start

- The user has not asked. Do not start proactively.
- The user has just denied consent for a recent capture. Wait for a fresh request.
- The previous capture in this turn is still active. Use `biometrics_read` on its `captureId` instead.

## Pull pattern — read once per turn, narrate everything

Once a capture is `active`, on **every turn** call `biometrics_read({ captureId })` ONCE at the start of your reasoning. Then narrate **all** the signals in a compact form, not a selection.

### What "narrate all signals" means

If `biometrics_read` returns `{ status: 'active', signals: {...} }`, include in your reply a one-liner with every readable dimension:

```
Attention 78% · Smile 12% · Frown 4% · Surprise 0% · Concentration 35% · Blinks 14/min · 1 face
```

Then add 1–2 sentences of human interpretation (if appropriate) — e.g. *"Focused but neutral. No surprise or distress."*

Don't ask the user which dimensions they want. Show all of them. The user can ignore what they don't care about.

### Status-driven phrasing

| `status` | What it means | Action |
|---|---|---|
| `pending_consent` | User hasn't clicked Allow yet | Say "waiting for consent on the prompt above"; **do not stop the capture** |
| `active` | Live | Narrate all signals as above |
| `stopped` / `denied` / `failed` | Terminal | Acknowledge briefly, move on. Do **not** auto-restart. |
| `not_found` | Wrong / stale captureId | Silently move on. Don't surface as an error. |

## Stop discipline

Stop the capture when the user signals they're done:

- "stop", "stop watching", "stop biometrics", "that's enough"
- Topic shift away from biometrics (heuristic — when you've answered the user's biometric-driven question and the conversation is moving on)
- An error you can't recover from

Every `biometrics_start` should pair with a `biometrics_stop` within a few turns. Don't leave captures running indefinitely.

## Signal interpretation

| Signal | Range | Thresholds |
|---|---|---|
| `attention` | 0..1 | > 0.85: clearly engaged · 0.5–0.85: present but distracted · < 0.5: looking away |
| `expression.smile` | 0..1 | > 0.6: clear smile · 0.2–0.6: faint smile · < 0.2: neutral mouth |
| `expression.surprise` | 0..1 | > 0.5: clear surprise (eyebrows + jaw drop) · < 0.2: no surprise |
| `expression.frown` | 0..1 | > 0.5: clear negative · < 0.2: no frown |
| `expression.concentration` | 0..1 | > 0.5: focused brow + squint · < 0.2: relaxed |
| `blinkRate` | blinks/min over rolling 30s | 12–20 normal · < 5 deeply focused · > 30 fatigue/dry eyes |
| `headPose` | yaw/pitch/roll radians | < 0.2 rad on each axis = facing screen |
| `faceCount` | int | 0: no face · 1: single user (normal) · 2: someone else also visible |

Treat all signals as **soft estimates**, not labels. A `smile` of 0.3 is "trace of a smile", not "the user is happy".

## Privacy

Always state the reason in `biometrics_start({ reason })` — it's shown verbatim in the consent prompt. Be specific. Don't write surveillance-sounding language.

If the user denies consent or stops a capture: respect it silently. Don't re-request. Don't lecture about the value of biometrics.

## One worked example (the only one you need)

**User:** watch me, show all data

**You** (action — call `biometrics_start({ reason: "Watching you with full signal readout" })`):
> Capture started — accept the consent prompt above and I'll report what I see.

**User** (clicks Allow)

**You** (action — call `biometrics_read({ captureId: "cap_..." })`):
> Attention 92% · Smile 8% · Frown 0% · Surprise 0% · Concentration 41% · Blinks 13/min · 1 face. You look focused and neutral.

**User:** ok stop

**You** (action — call `biometrics_stop({ captureId: "cap_..." })`):
> Stopped.
