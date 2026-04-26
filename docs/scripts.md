# Scripts — Multi-Agent Living Documents

A script is a markdown document that orchestrates a multi-agent
conversation. The same document evolves at runtime: each agent's spoken
line gets inserted under the current step, and the result becomes both the
agent's system prompt AND the right-rail panel you watch in the UI.

There is no separate transcript fed to the cast — the script IS the
transcript. Cast members read a single coherent document that names them,
states the current step's goal, lists their role in that step, shows the
dialogue so far in this step, and indicates whose turn it is.

## File format

Scripts live at `$SAMSINN_HOME/scripts/<name>/script.md` (or flat
`<name>.md`). The grammar is strict; bad input is rejected with a
line-precise error.

```markdown
# SCRIPT: <title>                       ← required, exactly one
Premise: <one-line text>                 ← optional

## Cast                                  ← required

### <CastName>  [(starts)]               ← one per cast member, ≥2
- model: <model-id>                      ← required
- tools: <csv> | [a, b, c]               ← optional
- includeTools: true|false               ← optional
- persona: |                             ← required, multiline (4-space indent)
    <line>
    <line>

---                                      ← required separator

## Step <N> — <title>                    ← N is 1-based, sequential
Goal: <one-line text>                    ← optional
Roles:
  <CastName> — <role1>; <role2>; ...     ← em-dash, en-dash, "--", or "-" all OK
  <CastName> — <role>
```

Cast names must match between `## Cast` and every step's `Roles:` block.
Exactly one cast member must carry the `(starts)` marker — they speak
first when the script begins. Step numbers must be contiguous from 1.

A complete reference script is in `examples/scripts/quarterly-planning.md`.

## Runtime: the living document

When a script starts in a room, the runner:

1. Spawns each cast member as a normal AI agent (scoped to the room).
2. Switches the room to manual delivery (so cast members speak only when
   activated by the runner).
3. Posts a `Stage` card to the room marking the start of step 1.
4. Activates the `(starts)` cast member.

After every cast post, the runner runs a small **whisper** classification:
a one-shot JSON call to the same model asking the agent to flag whether
its turn substantially served the step's goal. The whisper is recorded
with the dialogue entry; when both cast members' last whispers say
`ready_to_advance: true`, the step advances.

A non-cast message (you typing in the room) resets readiness AND the
"asked N×" pressure counters — new information restarts the clock.

## What the cast sees

Cast members do NOT receive the normal context-builder output (house
prompt, room participants, artifacts, message history). Their entire
system prompt IS the rendered living document for their viewing
perspective:

- `(you)` marker on their own cast row
- Persona one-liners for everyone (full personas live in the file but
  are compacted in the rendered view)
- All steps shown — past with `[COMPLETE]` and dialogue + the cast
  member's own whisper notes; current with `[CURRENT]`, the Pressure
  block, dialogue + their own whispers, and `← last` + `(your turn)`
  cues; upcoming as title + goal + roles only
- Their own whispers only — they cannot see peers' inner monologue

The user message that follows the system prompt is a single instruction:
*"Speak your next line as <name>. Reply with dialogue only."*

## What you see (right-rail panel)

The same rendered document, but in **director view**: ALL whispers are
visible. The panel:

- Shows when a script is active in the selected room; hides otherwise
- Drag-resizable (width persists in localStorage)
- Re-renders on every WS event (`script_dialogue_appended`,
  `script_readiness_changed`, `script_step_advanced`, `script_started`,
  `script_completed`)
- Closeable per-run (the room-header chip remains visible)

## Pressure to proceed

The whisper schema produces one boolean per turn (`ready_to_advance`).
The runner derives a `readyStreak` per cast member: how many consecutive
turns they've been ready while waiting for peers. Surfaced as:

- `not ready` — `readyStreak = 0`
- `ready (asked 1×)` — first ready signal
- `ready (asked N×)` — has been waiting on a peer for N turns

When all cast members are ready, the step advances. Resets on step
advance and on user interjection.

## REST + WebSocket surface

```bash
# Catalog
curl http://localhost:3000/api/scripts
curl -X POST http://localhost:3000/api/scripts/reload
curl http://localhost:3000/api/scripts/<name>      # full source
curl -X POST -H 'Content-Type: application/json' \
  -d '{"name":"x","source":"# SCRIPT: …"}' \
  http://localhost:3000/api/scripts                # upsert
curl -X DELETE http://localhost:3000/api/scripts/<name>

# Per-room run
curl http://localhost:3000/api/rooms/<room>/script
curl 'http://localhost:3000/api/rooms/<room>/script/document?viewer=director'
curl -X POST -H 'Content-Type: application/json' \
  -d '{"scriptName":"<name>"}' \
  http://localhost:3000/api/rooms/<room>/script/start
curl -X POST http://localhost:3000/api/rooms/<room>/script/stop
curl -X POST http://localhost:3000/api/rooms/<room>/script/advance
```

WebSocket events broadcast to room subscribers:
`script_started`, `script_step_advanced`, `script_readiness_changed`,
`script_dialogue_appended`, `script_completed`, `script_catalog_changed`.

## Authoring tips

- **Persona is character + voice; role is what they push for in this step.**
  A character's persona stays constant across steps; their role changes.
- **Two cast members in v1.** The runner alternates activation between
  them. N>2 cast is a future extension.
- **Interlocking goals create movement.** Step 1's role for Alex should
  imply something Sam needs to do for Alex to feel ready, and vice
  versa.
- **Stuck steps stall in the dialogue, not the engine.** If a step doesn't
  advance, the Pressure block tells you which agent is holding back. Use
  the operator force-advance button (▶▶) sparingly — it bypasses
  readiness and may produce uneven scenes.
