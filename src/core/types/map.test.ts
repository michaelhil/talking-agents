import { describe, expect, test } from 'bun:test'
import {
  parseMapBody,
  validateMapEnvelope,
  formatMapErrors,
  collectEnvelopeLatLngs,
  MARKER_ICONS,
  type ValidatedMap,
} from './map.ts'

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
