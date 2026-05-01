import { describe, expect, test } from 'bun:test'
import { parseMapSource, collectLatLngs } from './normalise.ts'

describe('parseMapSource — sniff', () => {
  test('FeatureCollection routed to geojson branch', () => {
    const r = parseMapSource(JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [10, 60] } }],
    }))
    expect(r.kind).toBe('geojson')
    if (r.kind === 'geojson') expect(r.data.features.length).toBe(1)
  })

  test('envelope with features array routed to envelope branch', () => {
    const r = parseMapSource(JSON.stringify({
      features: [{ type: 'marker', lat: 60, lng: 10 }],
    }))
    expect(r.kind).toBe('envelope')
    if (r.kind === 'envelope') expect(r.data.features[0]?.type).toBe('marker')
  })

  test('view applied on both shapes', () => {
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
    if (gj.kind !== 'geojson') throw new Error('expected geojson')
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

  test('unknown icon name silently dropped, marker still valid', () => {
    const r = parseMapSource(JSON.stringify({
      features: [{ type: 'marker', lat: 60, lng: 10, icon: 'starship' }],
    }))
    if (r.kind !== 'envelope') throw new Error('expected envelope')
    const f = r.data.features[0]
    if (f?.type !== 'marker') throw new Error('expected marker')
    expect(f.icon).toBeUndefined()
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

describe('collectLatLngs — geojson [lng,lat] → [lat,lng] flip', () => {
  test('Point geometry', () => {
    const r = parseMapSource(JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [10, 60] } }],
    }))
    if (r.kind !== 'geojson') throw new Error('expected geojson')
    expect(collectLatLngs(r)).toEqual([[60, 10]])
  })

  test('LineString', () => {
    const r = parseMapSource(JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[10, 60], [11, 61]] } }],
    }))
    if (r.kind !== 'geojson') throw new Error('expected geojson')
    expect(collectLatLngs(r)).toEqual([[60, 10], [61, 11]])
  })

  test('Polygon (single ring)', () => {
    const r = parseMapSource(JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[10, 60], [11, 61], [12, 62], [10, 60]]] },
      }],
    }))
    if (r.kind !== 'geojson') throw new Error('expected geojson')
    expect(collectLatLngs(r)).toEqual([[60, 10], [61, 11], [62, 12], [60, 10]])
  })

  test('empty FeatureCollection produces empty bounds', () => {
    const r = parseMapSource(JSON.stringify({ type: 'FeatureCollection', features: [] }))
    if (r.kind !== 'geojson') throw new Error('expected geojson')
    expect(collectLatLngs(r)).toEqual([])
  })
})
