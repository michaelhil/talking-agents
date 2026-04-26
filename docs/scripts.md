# Scripts — Multi-Agent Improvisational Drama

## Premise

Multi-agent conversations driven by hand-written turn-prompts (the old macro
system) feel artificial. Round-robin sequencing forces structure where there
should be intention. This document specifies **scripts**: a replacement that
treats a multi-agent exchange like an improv troupe playing a loose script,
not like a state machine cycling through agents.

A script is **a stage**, not a controller. There is no narrator, no director,
no judge. Agents are characters with private wants. Resolution is structural.

Scripts replace macros entirely.

## The shape of a script

A script is data. Three layers:

```
script:
  acts:                                # speech-act glossary, per-script
    admit_knowledge: "speaker acknowledges they knew something concealed"
    deflect:         "speaker redirects without committing"
    forgive:         "speaker releases the other from accountability"
    withdraw:        "speaker disengages from the line of questioning"

  cast:                                # one entry per character, full agent config
    Anna: { systemPrompt, model, tools, skills, ... }
    Bob:  { ... }

  scenes:
    - setup: "Anna's apartment, late evening. Bob has been waiting an hour."
      present: [Anna, Bob]
      objectives:
        Anna:
          want: "confront Bob about the affair"
          signal: { acts: { Bob: [admit_knowledge] } }
        Bob:
          want: "avoid confessing without lying"
          signal:
            any_of:
              - { status: { Anna: abandoned } }
              - { acts:   { Bob:  [admit_knowledge] } }
```

That is the entire authoring surface for the minimum scene.

### Cast
Each cast member is a full Samsinn agent config — persona, model, tools, skills.
Spawned at script start, despawned at script end. Entrances/exits between scenes
are handled by a scene's `present` list; mid-scene cast changes are not allowed.

### Acts (speech-act glossary)
A per-script dictionary of named acts. Each act has a one-line description.
Characters declare which acts their dialogue performs (via `update_beat`).
Author signals match against declared acts. Closed within a script,
arbitrary across scripts. A starter library may be imported, but no act
vocabulary is privileged by the system.

### Scenes
Setup paragraph + cast list + per-character objectives. An objective is a
`want` (free-text pursuit) + a `signal` (structural success criterion).

### Signals
Composable predicates over two primitives:

- `acts: { <character>: [<act>, …] }` — one of these acts was declared by
  that character at any point in the scene.
- `status: { <character>: met | abandoned }` — that character reached that
  posture.

Combinator: `any_of: [ … ]`. That's the whole signal grammar.

## How a turn runs

**Phase 1 — react.** Every present character receives a minimal context
(scene setup + their objective + the latest message + peer mood tags) and
calls a built-in `update_beat` tool only:

```
update_beat(
  status:        pursuing | met | abandoned,
  intent:        speak | hold,
  addressed_to?: <character>,
  mood?:         <one word>
)
```

No dialogue is produced in phase 1. Calls fan out in parallel.

**Phase 2 — speak.** A selection rule picks one character to speak:

1. Last turn's named addressee, if they bid `intent: speak`.
2. Otherwise, longest-quiet character bidding `speak`.
3. No one bids → record `(silence)` in the transcript and re-poll next turn.

The selected character runs a normal full-context generation, producing
dialogue plus a final `update_beat` call that includes
`speech_acts: [<act>, …]` declaring what acts the dialogue performed.

## How a scene resolves

Signals are evaluated after each phase-2 turn against:
- The growing list of speech-acts declared in the scene.
- The current statuses of all present characters.

When a character's signal matches, their status auto-advances to `met`.
A character can also self-mark `abandoned` via `update_beat`.

**Scene ends** when every present character is `met` or `abandoned`.

**Resolved characters stay present** but become reactive: their phase-2
context gains a flag (*"you have what you came for"* / *"you've stopped
pursuing"*) so they no longer drive the scene.

**Scene fizzles** if a stall condition holds: N consecutive turns with no
status transitions and no new speech-acts declared. After M further stalled
turns the scene auto-ends with status `fizzled`. UI surfaces the fizzle
honestly. There is no save mechanism, no narration, no nudge.

## What is deliberately absent

- **Narrator.** The system never speaks in prose mid-scene. The only
  engine-emitted text is the **setup card** at scene boundaries (sender
  name `Stage`, bracket-prefixed `[Scene N] ...`) — a structural stage
  direction the cast reads, not a voice in the scene. There is no
  ambient narration, no pressure narration, no closing line.
- **Director / judge.** No agent or rule decides scene-end on behalf of the
  characters. Every status is either self-declared by a character or
  structurally derived from declared acts.
- **Turn caps.** No min, no max. Scenes run as long as productive movement
  occurs.
- **Pressure narration.** No prose injected mid-scene to nudge agents. If a
  scene stalls, it stalls; if it keeps stalling, it fizzles.
- **Director's notes / mid-scene authoring overrides.** None. If a scene
  doesn't go where the author wanted, the author rewrites — or accepts the
  divergence by editing the next scene's setup.
- **Quorum or voting on scene-end.** Each character speaks for themselves
  about themselves.

## Inter-scene memory

Each character is a real agent with their own message history. Their
subjective record of past scenes *is* their history. Off-stage scenes
(those a character was not `present` for) do not enter their context unless
the next scene's setup explicitly summarizes what they would know.

Characters may differ in what they remember, and that asymmetry is dramatic
fuel rather than a bug.

## Cost

Per turn: N small phase-1 generations (parallel, minimal context) + 1
full phase-2 generation. Roughly 1.5× a normal multi-agent broadcast turn.

## Authoring guidance

- **Objectives are wants, not lines.** `signal` references *acts*, never
  dialogue strings. The closed glossary enforces this — there is no way to
  match against specific words.
- **Interlocking objectives create drama.** Anna's `met` should require
  something Bob does. Bob's `met` should give him a way out that conflicts
  with Anna's want. Scenes resolve when characters negotiate it out of each
  other.
- **Scenes that can't resolve will fizzle.** If both `met` paths are
  impossible, the system tells you by fizzling. Rewrite.
- **Stable persona, scene-scoped objective.** A character's `systemPrompt`
  and skills carry across scenes. Only the `objective` changes per scene.

## Replaces macros

The existing macro system (`MacroStep`, `MacroRun`, macro artifact, macro
overlay on delivery, macro UI panel/editor) is removed in full. Macros and
scripts are not coexisting concepts; scripts are the successor.

## Running a script

Drop a script under `~/.samsinn/scripts/<name>/script.json` (or flat
`~/.samsinn/scripts/<name>.json`). Reload the catalog and start a run in
an existing room:

```bash
# Inspect the catalog
curl http://localhost:3000/api/scripts

# Reload after editing files
curl -X POST http://localhost:3000/api/scripts/reload

# Start a script in a room (the room must already exist)
curl -X POST http://localhost:3000/api/rooms/<room>/script/start \
  -H 'Content-Type: application/json' \
  -d '{"scriptName": "the-accusation"}'

# Inspect the live run
curl http://localhost:3000/api/rooms/<room>/script

# Stop early
curl -X POST http://localhost:3000/api/rooms/<room>/script/stop
```

While a script is active the room is set to manual delivery. AI cast members
are spawned under scoped names (`script-<roomId8>-<castName>`) and despawned
on stop. WebSocket clients receive `script_started`, `script_scene_advanced`,
`script_beat`, `script_completed` events.

A complete reference script is in `examples/scripts/the-accusation.json`.
