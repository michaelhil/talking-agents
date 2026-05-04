# Maps

Developer-facing reference. Agent-facing instructions live in tool descriptions (`geo_lookup`, `geo_list_features`) — agents don't read this file.

## One ingestion path

Maps render INLINE via fenced code blocks:

````markdown
```map
{ "features": [ { "type": "marker", "lat": 60.39, "lng": 5.32, "label": "Bergen" } ] }
```
````

`add_artifact { type: 'map' }` is intentionally rejected with a structured error pointing the agent at the inline path. There is no map artifact type.

## Schema

Single source of truth: `src/core/types/map.ts`. Two input shapes are accepted; both normalize to one envelope shape internally.

### Envelope (preferred)

```ts
{
  view?: { center: [lat, lng], zoom: 1..19 }   // optional; auto-fits if omitted
  features: Array<
    | { type: 'marker',  lat, lng, label?, tooltip?, icon?, color? }
    | { type: 'line',    coords: [[lat,lng], ...], color?, weight? }
    | { type: 'track',   coords: [[lat,lng], ...], color?, weight? }   // alias for line
    | { type: 'polygon', coords: [[lat,lng], ...], color?, fillColor? }
    | { type: 'circle',  lat, lng, radius, color? }
  >
}
```

### GeoJSON FeatureCollection

Standard `{ type: 'FeatureCollection', features: [...] }`. Currently only `Point` geometry is normalized into envelope markers. `properties.name` becomes the marker label; `properties.icon` and `properties.color` flow through.

## Marker icons (closed enum)

`pin | platform | airport | plane | ship | city | dot`

Anything else is a validation error — no silent fallback. The `color` parameter recolors any icon, so variation within a category (e.g. parked vs. en-route aircraft) doesn't require new icon names.

## Coordinate convention

- Envelope: `lat`/`lng` as separate numbers (or `[lat, lng]` pairs in coords arrays).
- GeoJSON: `[lng, lat]` per spec — the validator flips on the way in.

## Error handling

Validation returns `{ok: false, errors: [{path, message}]}`. The renderer turns errors into an inline banner with `<details>` showing the source. The same text appears in the agent's chat-history context on the next turn so the agent can self-correct.

## Tools that emit ready-to-paste fences

- `geo_lookup` — name → coordinates via local store + OSM cascade
- `geo_list_features` — bulk filter + map envelope for a category

Both return `data.renderable: "\`\`\`map\\n{...}\\n\`\`\`"` — drop verbatim into a chat reply.

## Files

- `src/core/types/map.ts` — schema, validator, parser. **Single source of truth.**
- `src/ui/modules/map/normalise.ts` — thin renderer-facing bridge.
- `src/ui/modules/map/index.ts` — Leaflet renderer (always uses divIcon — no bitmap dependency).
- `src/ui/modules/map/icons.ts` — SVG factory per icon.
- `src/ui/modules/map/fallback.ts` — structured error banner.
- `src/tools/built-in/geo-tools.ts` — geo_lookup / geo_list_features emit `renderable`.
