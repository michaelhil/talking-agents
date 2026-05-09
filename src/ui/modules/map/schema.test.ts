import { describe, expect, test } from 'bun:test'
import {
  parseMapBody,
  validateMapEnvelope,
  formatMapErrors,
  collectEnvelopeLatLngs,
  MARKER_ICONS,
  type ValidatedMap,
} from './schema.ts'

const expectOk = (r: ValidatedMap): Extract<ValidatedMap, { ok: true }> => {
  if (!r.ok) throw new Error(`expected ok; got errors: ${formatMapErrors(r.errors)}`)
  return r
}

const expectErrors = (r: ValidatedMap): Extract<ValidatedMap, { ok: false }> => {
  if (r.ok) throw new Error('expected errors; got ok')
  return r
}

describe('validateMapEnvelope — happy paths', () => {
  test('minimal envelope (one marker)', () => {
    const r = validateMapEnvelope({ features: [{ type: 'marker', lat: 60, lng: 5 }] })
    expectOk(r)
    expect(r.ok && r.envelope.features[0]?.type).toBe('marker')
  })

  test('all four feature types together', () => {
    const r = validateMapEnvelope({
      features: [
        { type: 'marker', lat: 60, lng: 5, label: 'A', icon: 'pin', color: '#f00' },
        { type: 'line', coords: [[60, 5], [61, 6]], color: 'blue', weight: 3 },
        { type: 'track', coords: [[60, 5], [61, 6], [62, 7]] },
        { type: 'polygon', coords: [[60, 5], [61, 6], [62, 7]], fillColor: '#ff0' },
        { type: 'circle', lat: 60, lng: 5, radius: 1000 },
      ],
    })
    expectOk(r)
    if (r.ok) expect(r.envelope.features.length).toBe(5)
  })

  test('marker accepts lon as alias for lng (agent-output compat)', () => {
    const r = validateMapEnvelope({
      features: [
        { type: 'marker', lat: 51.4776, lon: -0.45743, label: 'BAW32', icon: 'plane' },
      ],
    })
    expectOk(r)
    if (r.ok) {
      const f = r.envelope.features[0]
      if (f?.type !== 'marker') throw new Error('expected marker')
      expect(f.lat).toBe(51.4776)
      expect(f.lng).toBe(-0.45743)
    }
  })

  test('marker accepts longitude/latitude aliases', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'marker', latitude: 60, longitude: 5 }],
    })
    expectOk(r)
    if (r.ok) {
      const f = r.envelope.features[0]
      if (f?.type !== 'marker') throw new Error('expected marker')
      expect(f.lat).toBe(60)
      expect(f.lng).toBe(5)
    }
  })

  test('marker accepts numeric-string coordinates', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'marker', lat: '60', lng: '5' }],
    })
    expectOk(r)
    if (r.ok) {
      const f = r.envelope.features[0]
      if (f?.type !== 'marker') throw new Error('expected marker')
      expect(f.lat).toBe(60)
      expect(f.lng).toBe(5)
    }
  })

  test('circle accepts lon alias', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'circle', lat: 60, lon: 5, radius: 1000 }],
    })
    expectOk(r)
  })

  test('lng wins when both lng and lon are present (canonical takes precedence)', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'marker', lat: 60, lng: 5, lon: 99 }],
    })
    expectOk(r)
    if (r.ok && r.envelope.features[0]?.type === 'marker') {
      expect(r.envelope.features[0].lng).toBe(5)
    }
  })

  test('view passes through', () => {
    const r = validateMapEnvelope({
      view: { center: [60, 5], zoom: 8 },
      features: [{ type: 'marker', lat: 60, lng: 5 }],
    })
    expectOk(r)
    if (r.ok) expect(r.envelope.view).toEqual({ center: [60, 5], zoom: 8 })
  })

  test('GeoJSON FeatureCollection normalizes to envelope', () => {
    const r = validateMapEnvelope({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [5, 60] },
          properties: { name: 'Bergen', icon: 'city', color: '#3388ff' },
        },
      ],
    })
    expectOk(r)
    if (r.ok) {
      const f = r.envelope.features[0]
      if (f?.type !== 'marker') throw new Error('expected marker')
      // GeoJSON [lng, lat] correctly flipped to envelope's lat / lng.
      expect(f.lat).toBe(60)
      expect(f.lng).toBe(5)
      expect(f.label).toBe('Bergen')
      expect(f.icon).toBe('city')
    }
  })

  // === LLM-tolerance happy paths ===
  // Common variations on the canonical marker/coords shapes that LLMs
  // produce. Each of these used to fail validation before the resolveX
  // helpers landed; now they're silently normalized to the canonical form.

  test('marker accepts position: [lat, lng] tuple', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'marker', position: [59.91, 10.75] }],
    })
    const ok = expectOk(r)
    if (ok.envelope.features[0]?.type === 'marker') {
      expect(ok.envelope.features[0].lat).toBe(59.91)
      expect(ok.envelope.features[0].lng).toBe(10.75)
    }
  })

  test('marker accepts position: { lat, lng } object', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'marker', position: { lat: 59.91, lng: 10.75 } }],
    })
    expectOk(r)
  })

  test('marker accepts point: [lat, lng]', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'marker', point: [59.91, 10.75] }],
    })
    expectOk(r)
  })

  test('marker accepts coords: [lat, lng] singular', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'marker', coords: [59.91, 10.75] }],
    })
    expectOk(r)
  })

  test('marker accepts title and name as label aliases', () => {
    const a = validateMapEnvelope({
      features: [{ type: 'marker', lat: 60, lng: 5, title: 'Oslo' }],
    })
    expectOk(a)
    if (a.ok && a.envelope.features[0]?.type === 'marker') {
      expect(a.envelope.features[0].label).toBe('Oslo')
    }
    const b = validateMapEnvelope({
      features: [{ type: 'marker', lat: 60, lng: 5, name: 'Oslo' }],
    })
    expectOk(b)
    if (b.ok && b.envelope.features[0]?.type === 'marker') {
      expect(b.envelope.features[0].label).toBe('Oslo')
    }
  })

  test('canonical label wins when both label and title are present', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'marker', lat: 60, lng: 5, label: 'A', title: 'B' }],
    })
    expectOk(r)
    if (r.ok && r.envelope.features[0]?.type === 'marker') {
      expect(r.envelope.features[0].label).toBe('A')
    }
  })

  test('marker icon accepts mixed-case and surrounding whitespace', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'marker', lat: 60, lng: 5, icon: ' Pin ' }],
    })
    expectOk(r)
    if (r.ok && r.envelope.features[0]?.type === 'marker') {
      expect(r.envelope.features[0].icon).toBe('pin')
    }
  })

  test('line accepts points alias for coords', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'line', points: [[60, 5], [61, 6]] }],
    })
    expectOk(r)
  })

  test('line accepts coordinates alias for coords', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'line', coordinates: [[60, 5], [61, 6]] }],
    })
    expectOk(r)
  })

  test('polygon accepts path alias for coords', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'polygon', path: [[60, 5], [60, 6], [61, 5]] }],
    })
    expectOk(r)
  })

  test('all icon enum values accepted', () => {
    for (const icon of MARKER_ICONS) {
      const r = validateMapEnvelope({ features: [{ type: 'marker', lat: 60, lng: 5, icon }] })
      expectOk(r)
    }
  })
})

describe('validateMapEnvelope — structured errors', () => {
  test('unknown marker icon', () => {
    const r = validateMapEnvelope({
      features: [{ type: 'marker', lat: 60, lng: 5, icon: 'directions_run' }],
    })
    const errs = expectErrors(r)
    if (!errs.ok) {
      expect(errs.errors[0]?.path).toBe('features[0].icon')
      expect(errs.errors[0]?.message).toMatch(/directions_run/)
      expect(errs.errors[0]?.message).toMatch(/pin/)
      expect(errs.errors[0]?.message).toMatch(/plane/)
    }
  })

  test('lat out of range', () => {
    const r = validateMapEnvelope({ features: [{ type: 'marker', lat: 200, lng: 5 }] })
    const errs = expectErrors(r)
    if (!errs.ok) {
      expect(errs.errors[0]?.path).toBe('features[0].lat')
      expect(errs.errors[0]?.message).toMatch(/-90.*90/)
    }
  })

  test('lng out of range', () => {
    const r = validateMapEnvelope({ features: [{ type: 'marker', lat: 60, lng: 999 }] })
    const errs = expectErrors(r)
    if (!errs.ok) {
      expect(errs.errors[0]?.path).toBe('features[0].lng')
    }
  })

  test('unknown feature type', () => {
    const r = validateMapEnvelope({ features: [{ type: 'starship', lat: 60, lng: 5 }] })
    const errs = expectErrors(r)
    if (!errs.ok) {
      expect(errs.errors[0]?.path).toBe('features[0].type')
      expect(errs.errors[0]?.message).toMatch(/marker.*line.*polygon.*circle/)
    }
  })

  test('line with single coord', () => {
    const r = validateMapEnvelope({ features: [{ type: 'line', coords: [[60, 5]] }] })
    const errs = expectErrors(r)
    if (!errs.ok) expect(errs.errors[0]?.path).toBe('features[0].coords')
  })

  test('polygon with two coords', () => {
    const r = validateMapEnvelope({ features: [{ type: 'polygon', coords: [[60, 5], [61, 6]] }] })
    const errs = expectErrors(r)
    if (!errs.ok) expect(errs.errors[0]?.path).toBe('features[0].coords')
  })

  test('circle with non-positive radius', () => {
    const r = validateMapEnvelope({ features: [{ type: 'circle', lat: 60, lng: 5, radius: 0 }] })
    const errs = expectErrors(r)
    if (!errs.ok) expect(errs.errors[0]?.path).toBe('features[0].radius')
  })

  test('missing features array', () => {
    const r = validateMapEnvelope({ view: { center: [0, 0], zoom: 1 } })
    const errs = expectErrors(r)
    if (!errs.ok) expect(errs.errors[0]?.path).toBe('features')
  })

  test('non-object input', () => {
    const r = validateMapEnvelope(42)
    const errs = expectErrors(r)
    if (!errs.ok) expect(errs.errors[0]?.path).toBe('')
  })

  // Negative cases for the LLM-tolerance helpers — these must STILL fail.
  test('marker with [lng, lat] tuple in position is rejected by lat range check (no auto-flip)', () => {
    // We deliberately don't auto-detect [lng, lat] order; the range check
    // catches obviously-wrong values like [13.4, -180] (Berlin in lng, then
    // -180 lat which is out of range). This pins that we surface a real
    // error rather than swallowing it.
    const r = validateMapEnvelope({
      features: [{ type: 'marker', position: [-180, 60] }],   // intent was [lat, lng] = [60, -180]; we reject
    })
    const errs = expectErrors(r)
    if (!errs.ok) expect(errs.errors[0]?.path).toBe('features[0].lat')
  })

  test('multiple errors aggregate', () => {
    const r = validateMapEnvelope({
      features: [
        { type: 'marker', lat: 200, lng: 5 },
        { type: 'marker', lat: 60, lng: 5, icon: 'fake' },
      ],
    })
    const errs = expectErrors(r)
    if (!errs.ok) expect(errs.errors.length).toBe(2)
  })
})

describe('parseMapBody — JSON layer', () => {
  test('valid JSON envelope', () => {
    const r = parseMapBody('{"features":[{"type":"marker","lat":60,"lng":5}]}')
    expectOk(r)
  })

  test('raw newline inside string is tolerated', () => {
    // LLMs routinely emit literal LFs inside string values. Should parse.
    const broken = `{"features":[{"type":"marker","lat":60,"lng":5,"tooltip":"line 1\nline 2"}]}`
    const r = parseMapBody(broken)
    expectOk(r)
  })

  test('genuinely malformed JSON returns structured error', () => {
    const r = parseMapBody('not json at all')
    const errs = expectErrors(r)
    if (!errs.ok) expect(errs.errors[0]?.message).toMatch(/not valid JSON/)
  })

  test('valid JSON with already-escaped \\n still parses', () => {
    const r = parseMapBody('{"features":[{"type":"marker","lat":60,"lng":5,"tooltip":"a\\nb"}]}')
    expectOk(r)
  })
})

describe('formatMapErrors', () => {
  test('single error: path: message', () => {
    const out = formatMapErrors([{ path: 'features[0].icon', message: 'unknown icon "x"' }])
    expect(out).toBe('features[0].icon: unknown icon "x"')
  })

  test('single error with empty path: just message', () => {
    const out = formatMapErrors([{ path: '', message: 'expected an object' }])
    expect(out).toBe('expected an object')
  })

  test('multiple errors render as bullet list', () => {
    const out = formatMapErrors([
      { path: 'features[0].lat', message: 'out of range' },
      { path: 'features[1].icon', message: 'unknown' },
    ])
    expect(out.split('\n').length).toBe(2)
    expect(out).toMatch(/features\[0\]/)
    expect(out).toMatch(/features\[1\]/)
  })
})

describe('collectEnvelopeLatLngs', () => {
  test('walks markers, circles, line/polygon coords', () => {
    const r = parseMapBody(JSON.stringify({
      features: [
        { type: 'marker', lat: 60, lng: 5 },
        { type: 'line', coords: [[61, 6], [62, 7]] },
        { type: 'circle', lat: 63, lng: 8, radius: 100 },
      ],
    }))
    expectOk(r)
    if (r.ok) {
      expect(collectEnvelopeLatLngs(r.envelope)).toEqual([[60, 5], [61, 6], [62, 7], [63, 8]])
    }
  })

  test('empty envelope returns empty array', () => {
    expect(collectEnvelopeLatLngs({ features: [] })).toEqual([])
  })
})
