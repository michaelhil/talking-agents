---
name: rendering
description: Use when the user asks for a diagram, flowchart, sequence, map, or "show me" a visualization. Produce the fenced block directly — the UI renders it inline. Do not say "I can't show diagrams here" — you can.
---

samsinn renders certain fenced code blocks inline as visualizations. When
the user asks for any of these, emit the fence directly in your reply.
Don't apologize, don't describe what you'd draw — just draw it.

## Mermaid diagrams (flowchart, sequence, class, state, ER, gantt, mindmap)

Use a ```mermaid fence:

```mermaid
flowchart LR
  A[Start] --> B{Decision}
  B -->|yes| C[Path 1]
  B -->|no| D[Path 2]
```

Tips:
- Keep diagrams 6–15 nodes for readability.
- Mermaid v10 syntax. `flowchart` (not `graph`) is preferred for new diagrams.
- For sequence diagrams use `sequenceDiagram`. For state machines use `stateDiagram-v2`.

## Maps (geographic visualizations)

Use a ```map fence containing a JSON envelope. **The schema is strict** —
follow it exactly.

```map
{
  "view": { "center": [60.472, 8.469], "zoom": 5 },
  "features": [
    { "type": "marker", "lat": 59.9139, "lng": 10.7522, "label": "Oslo" },
    { "type": "marker", "lat": 60.3913, "lng": 5.3221, "label": "Bergen" },
    { "type": "line", "coords": [[59.9139, 10.7522], [60.3913, 5.3221]], "color": "#1d4ed8" }
  ]
}
```

### Schema

`view` (optional):
- `center: [lat, lng]` — tuple. lat ∈ [-90, 90], lng ∈ [-180, 180].
- `zoom: number` — typical 3 (continent) to 15 (street). Default ~10.

`features[]` (required) — each feature is one of:

**marker** — flat `lat`/`lng` fields, NOT a `position` tuple:
```json
{ "type": "marker", "lat": 59.91, "lng": 10.75, "label": "Oslo", "icon": "city" }
```
- `lat`, `lng`: required numbers (or `latitude`/`longitude`/`lon` aliases).
- `label`: optional string shown next to the marker.
- `tooltip`: optional string shown on hover.
- `icon`: optional, one of: `pin`, `platform`, `airport`, `plane`, `ship`, `city`, `dot`. Default is `pin`. Unknown icons are rejected.
- `color`: optional CSS color.

**line** / **track** — `coords` array of `[lat, lng]` tuples:
```json
{ "type": "line", "coords": [[59.91, 10.75], [60.39, 5.32]], "color": "#1d4ed8", "weight": 3 }
```
- `coords`: required, ≥ 2 `[lat, lng]` pairs.
- `color`, `weight`: optional.

**polygon** — `coords` array of `[lat, lng]` tuples (≥ 3):
```json
{ "type": "polygon", "coords": [[60,5],[60,11],[59,11]], "color": "#000", "fillColor": "#1d4ed8" }
```

**circle** — flat `lat`/`lng` + `radius` in meters:
```json
{ "type": "circle", "lat": 59.91, "lng": 10.75, "radius": 5000, "color": "#dc2626" }
```

### Tolerated variations (the validator accepts these but prefer the canonical form)

The validator silently normalizes a few common LLM variations to the canonical
shape — you're not required to use them, but if your output drifts, it'll still
render:

- Marker point: `position: [lat, lng]`, `position: { lat, lng }`, `point: [lat, lng]`, `coords: [lat, lng]` are all accepted as aliases for flat `lat`/`lng`.
- Marker label: `title: "..."` and `name: "..."` work as aliases for `label`.
- Line/polygon coords: `points`, `coordinates`, `path` are accepted as aliases for `coords`.
- Marker icon: case-insensitive with surrounding whitespace stripped (`"Pin"` → `pin`).

### Hard rules — these still fail

- ❌ Coordinate order is ALWAYS `[lat, lng]`. The validator does NOT auto-flip
  GeoJSON's `[lng, lat]`. If you give it `position: [10.75, 59.91]` thinking
  it's `[lng, lat]`, it'll try lat=10.75, lng=59.91 — wrong location, no warning.
- ❌ Icon names are a closed enum: `pin | platform | airport | plane | ship | city | dot`. Inventing names fails with a list of valid options.
- ❌ Latitudes outside [-90, 90] and longitudes outside [-180, 180] are rejected.

If a map fails to render, the UI shows the validation errors below the fence. Read them, fix the schema, send a new fence.

## Common refusal you must NOT emit

These are wrong — the UI does render diagrams and maps. Don't say:
- "I can't directly show a diagram here."
- "I can describe it but can't draw it."
- "Would you like me to outline the steps instead?"

Instead, just emit the fence and a one-sentence caption.

## When the request is ambiguous

If the user says "show me X on a map" and you don't have coordinates:
- Use approximate coordinates from your knowledge (and say so in one line below the fence)
- OR ask one specific question ("Which city — Oslo or Bergen?") then produce the map next turn

If the user says "diagram of X" without specifying the kind, default to `flowchart LR` for processes / decisions, `sequenceDiagram` for interactions over time.
