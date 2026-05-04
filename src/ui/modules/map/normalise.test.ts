import { describe, expect, test } from 'bun:test'
import { parseMapSource, collectLatLngs } from './normalise.ts'

describe('parseMapSource — normalization to envelope', () => {
  test('GeoJSON FeatureCollection normalizes to envelope (single Point)', () => {
    const r = parseMapSource(JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [10, 60] } }],
    }))
    expect(r.kind).toBe('envelope')
    if (r.kind === 'envelope') {
      expect(r.data.features.length).toBe(1)
      expect(r.data.features[0]?.type).toBe('marker')
      // GeoJSON [lng, lat] correctly flipped to envelope's lat / lng.
      const f = r.data.features[0]
      if (f?.type !== 'marker') throw new Error('expected marker')
      expect(f.lat).toBe(60)
      expect(f.lng).toBe(10)
    }
  })

  test('GeoJSON Feature properties.name maps to envelope marker label', () => {
    const r = parseMapSource(JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [10, 60] },
        properties: { name: 'Bergen' },
      }],
    }))
    if (r.kind !== 'envelope') throw new Error('expected envelope')
    const f = r.data.features[0]
    if (f?.type !== 'marker') throw new Error('expected marker')
    expect(f.label).toBe('Bergen')
  })

  test('envelope with features array stays envelope', () => {
    const r = parseMapSource(JSON.stringify({
      features: [{ type: 'marker', lat: 60, lng: 10 }],
    }))
    expect(r.kind).toBe('envelope')
    if (r.kind === 'envelope') expect(r.data.features[0]?.type).toBe('marker')
  })

  test('view applied on both envelope and FeatureCollection inputs', () => {
    const env = parseMapSource(JSON.stringify({
      view: { center: [60, 10], zoom: 8 },
      features: [{ type: 'marker', lat: 60, lng: 10 }],
    }))
    if (env.kind !== 'envelope') throw new Error('expected envelope')
    expect(env.data.view).toEqual({ center: [60, 10], zoom: 8 })

    const gj = parseMapSource(JSON.stringify({
      type: 'FeatureCollection',
      view: { center: [60, 10], zoom: 8 },
      features: [],
    }))
    if (gj.kind !== 'envelope') throw new Error('expected envelope (normalized from GeoJSON)')
    expect(gj.data.view).toEqual({ center: [60, 10], zoom: 8 })
  })
})

describe('parseMapSource — invalid', () => {
  test('non-JSON', () => {
    const r = parseMapSource('not json')
    expect(r.kind).toBe('invalid')
  })

  test('non-object root', () => {
    const r = parseMapSource('42')
    expect(r.kind).toBe('invalid')
  })

  test('FeatureCollection with non-array features', () => {
    const r = parseMapSource(JSON.stringify({ type: 'FeatureCollection', features: 'oops' }))
    expect(r.kind).toBe('invalid')
  })

  test('envelope without features array', () => {
    const r = parseMapSource(JSON.stringify({ view: { center: [0, 0], zoom: 1 } }))
    expect(r.kind).toBe('invalid')
  })

  test('envelope with unknown feature type', () => {
    const r = parseMapSource(JSON.stringify({ features: [{ type: 'starship', lat: 0, lng: 0 }] }))
    expect(r.kind).toBe('invalid')
  })

  test('marker missing lng', () => {
    const r = parseMapSource(JSON.stringify({ features: [{ type: 'marker', lat: 60 }] }))
    expect(r.kind).toBe('invalid')
  })

  test('line with single coord', () => {
    const r = parseMapSource(JSON.stringify({ features: [{ type: 'line', coords: [[60, 10]] }] }))
    expect(r.kind).toBe('invalid')
  })

  test('polygon with 2 coords', () => {
    const r = parseMapSource(JSON.stringify({ features: [{ type: 'polygon', coords: [[60, 10], [61, 11]] }] }))
    expect(r.kind).toBe('invalid')
  })

  test('circle with negative radius', () => {
    const r = parseMapSource(JSON.stringify({ features: [{ type: 'circle', lat: 60, lng: 10, radius: -1 }] }))
    expect(r.kind).toBe('invalid')
  })
})

describe('parseMapSource — feature variants', () => {
  test('all four envelope feature types parse', () => {
    const r = parseMapSource(JSON.stringify({
      features: [
        { type: 'marker', lat: 60, lng: 10, label: 'A', color: 'red' },
        { type: 'line', coords: [[60, 10], [61, 11]], color: 'blue', weight: 3 },
        { type: 'track', coords: [[60, 10], [61, 11], [62, 12]] },
        { type: 'polygon', coords: [[60, 10], [61, 11], [62, 12]], fillColor: '#f00' },
        { type: 'circle', lat: 60, lng: 10, radius: 5000 },
      ],
    }))
    if (r.kind !== 'envelope') throw new Error('expected envelope')
    expect(r.data.features.length).toBe(5)
  })
})

describe('parseMapSource — marker icon', () => {
  test('known icon name preserved', () => {
    const r = parseMapSource(JSON.stringify({
      features: [{ type: 'marker', lat: 60, lng: 10, icon: 'plane', color: '#ff0000' }],
    }))
    if (r.kind !== 'envelope') throw new Error('expected envelope')
    const f = r.data.features[0]
    if (f?.type !== 'marker') throw new Error('expected marker')
    expect(f.icon).toBe('plane')
    expect(f.color).toBe('#ff0000')
  })

  test('unknown icon name produces structured error (no silent fallback)', () => {
    const r = parseMapSource(JSON.stringify({
      features: [{ type: 'marker', lat: 60, lng: 10, icon: 'directions_run' }],
    }))
    expect(r.kind).toBe('invalid')
    if (r.kind === 'invalid') {
      // Reason includes the offending icon AND the valid set so the agent
      // can self-correct on its next turn from chat-history context.
      expect(r.reason).toMatch(/directions_run/)
      expect(r.reason).toMatch(/pin/)
      expect(r.reason).toMatch(/plane/)
    }
  })

  test('all icon enum values accepted', () => {
    const icons = ['pin', 'plane', 'airport', 'platform', 'ship', 'city', 'dot']
    for (const icon of icons) {
      const r = parseMapSource(JSON.stringify({
        features: [{ type: 'marker', lat: 60, lng: 10, icon }],
      }))
      if (r.kind !== 'envelope') throw new Error(`expected envelope for icon ${icon}`)
      const f = r.data.features[0]
      if (f?.type !== 'marker') throw new Error('expected marker')
      expect(f.icon).toBe(icon as never)
    }
  })
})

describe('collectLatLngs — envelope', () => {
  test('walks markers, lines, polygons, circles', () => {
    const r = parseMapSource(JSON.stringify({
      features: [
        { type: 'marker', lat: 60, lng: 10 },
        { type: 'line', coords: [[61, 11], [62, 12]] },
        { type: 'circle', lat: 63, lng: 13, radius: 100 },
      ],
    }))
    if (r.kind !== 'envelope') throw new Error('expected envelope')
    const pts = collectLatLngs(r)
    expect(pts).toEqual([[60, 10], [61, 11], [62, 12], [63, 13]])
  })
})

describe('collectLatLngs — GeoJSON normalized to envelope', () => {
  test('Point in FeatureCollection flips [lng,lat] → [lat,lng]', () => {
    const r = parseMapSource(JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [10, 60] } }],
    }))
    if (r.kind !== 'envelope') throw new Error('expected envelope')
    expect(collectLatLngs(r)).toEqual([[60, 10]])
  })

  test('empty FeatureCollection normalizes to empty envelope', () => {
    const r = parseMapSource(JSON.stringify({ type: 'FeatureCollection', features: [] }))
    if (r.kind !== 'envelope') throw new Error('expected envelope')
    expect(r.data.features.length).toBe(0)
    expect(collectLatLngs(r)).toEqual([])
  })

  test('LineString currently rejected — only Point geometry normalizes', () => {
    // LineString → marker isn't meaningful. Could be added to normalize as
    // a `line` feature; deferred until needed.
    const r = parseMapSource(JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[10, 60], [11, 61]] } }],
    }))
    expect(r.kind).toBe('invalid')
  })
})

describe('parseMapSource — tolerant control-char escaping', () => {
  test('literal newline inside string literal still parses', () => {
    // Matches the real-world LLM output that broke the renderer:
    // a \n character (not the escape sequence) inside a tooltip value.
    const broken = `{"features":[{"type":"marker","lat":1,"lng":2,"label":"X","tooltip":"line 1\nline 2"}]}`
    const r = parseMapSource(broken)
    expect(r.kind).toBe('envelope')
  })

  test('literal tab + carriage return inside string literal also parses', () => {
    const broken = `{"features":[{"type":"marker","lat":1,"lng":2,"tooltip":"a\tb\rc"}]}`
    const r = parseMapSource(broken)
    expect(r.kind).toBe('envelope')
  })

  test('valid JSON with already-escaped \\n still parses (no double-escaping)', () => {
    // Pre-existing valid JSON should NOT be re-processed if JSON.parse succeeds.
    const valid = `{"features":[{"type":"marker","lat":1,"lng":2,"tooltip":"line 1\\nline 2"}]}`
    const r = parseMapSource(valid)
    expect(r.kind).toBe('envelope')
  })

  test('genuinely invalid JSON still surfaces the original error', () => {
    const r = parseMapSource('not json at all')
    expect(r.kind).toBe('invalid')
  })
})
