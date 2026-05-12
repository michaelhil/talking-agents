// Bundled demo tool — Norwegian Continental Shelf oil & gas platforms.
//
// Static, offline dataset compiled from public NPD (Norwegian Petroleum
// Directorate) records. We bundle the data in-binary so the "Norway
// Platforms" demo is fully reliable: no GitHub install, no network round
// trip, no rate limit failure mode. The dataset is small (~50 entries,
// well under 10 KB) — bundling cost is negligible.
//
// The tool returns a ready-to-paste ```map fenced block. The agent's
// persona instructs it to emit the fence verbatim so the inline-map
// renderer (src/ui/modules/map/) picks it up.

import type { Tool, ToolResult } from '../../../core/types/tool.ts'

interface Platform {
  readonly name: string
  readonly operator: string
  readonly lat: number
  readonly lng: number
  readonly type: 'oil' | 'gas' | 'oil-gas'
}

// ~50 platforms — vetted public-domain coordinates. Not exhaustive (the NCS
// has 90+ producing installations); curated to the recognizable majors so
// the map is readable rather than a marker pile-up.
const PLATFORMS: ReadonlyArray<Platform> = [
  // North Sea — south
  { name: 'Ekofisk',            operator: 'ConocoPhillips', lat: 56.5450, lng: 3.2167, type: 'oil-gas' },
  { name: 'Eldfisk',            operator: 'ConocoPhillips', lat: 56.3800, lng: 3.2330, type: 'oil' },
  { name: 'Embla',              operator: 'ConocoPhillips', lat: 56.3050, lng: 3.3160, type: 'oil-gas' },
  { name: 'Valhall',            operator: 'Aker BP',         lat: 56.2767, lng: 3.3933, type: 'oil' },
  { name: 'Hod',                operator: 'Aker BP',         lat: 56.1900, lng: 3.4400, type: 'oil' },
  { name: 'Ula',                operator: 'Aker BP',         lat: 57.1100, lng: 2.8500, type: 'oil' },
  { name: 'Gyda',               operator: 'Repsol',          lat: 56.9000, lng: 3.0833, type: 'oil' },
  { name: 'Tor',                operator: 'ConocoPhillips', lat: 56.6333, lng: 3.3333, type: 'oil-gas' },

  // North Sea — central (Sleipner / Heimdal area)
  { name: 'Sleipner A',         operator: 'Equinor',         lat: 58.3667, lng: 1.9000, type: 'gas' },
  { name: 'Sleipner B',         operator: 'Equinor',         lat: 58.4333, lng: 1.7167, type: 'gas' },
  { name: 'Sleipner T',         operator: 'Equinor',         lat: 58.3667, lng: 1.9000, type: 'gas' },
  { name: 'Heimdal',            operator: 'Equinor',         lat: 59.5750, lng: 2.2300, type: 'gas' },
  { name: 'Balder',             operator: 'Vår Energi',      lat: 59.1900, lng: 2.4100, type: 'oil' },
  { name: 'Ringhorne',          operator: 'Vår Energi',      lat: 59.5000, lng: 2.7700, type: 'oil' },
  { name: 'Grane',              operator: 'Equinor',         lat: 59.1700, lng: 2.4900, type: 'oil' },
  { name: 'Jotun',              operator: 'Vår Energi',      lat: 59.0000, lng: 2.0000, type: 'oil' },

  // North Sea — Tampen (Statfjord / Gullfaks / Snorre)
  { name: 'Statfjord A',        operator: 'Equinor',         lat: 61.2550, lng: 1.8530, type: 'oil-gas' },
  { name: 'Statfjord B',        operator: 'Equinor',         lat: 61.2050, lng: 1.8280, type: 'oil-gas' },
  { name: 'Statfjord C',        operator: 'Equinor',         lat: 61.3050, lng: 1.8930, type: 'oil-gas' },
  { name: 'Gullfaks A',         operator: 'Equinor',         lat: 61.1820, lng: 2.2700, type: 'oil-gas' },
  { name: 'Gullfaks B',         operator: 'Equinor',         lat: 61.2050, lng: 2.2580, type: 'oil-gas' },
  { name: 'Gullfaks C',         operator: 'Equinor',         lat: 61.2150, lng: 2.2700, type: 'oil-gas' },
  { name: 'Snorre A',           operator: 'Equinor',         lat: 61.4500, lng: 2.1500, type: 'oil' },
  { name: 'Snorre B',           operator: 'Equinor',         lat: 61.5167, lng: 2.0000, type: 'oil' },
  { name: 'Visund',             operator: 'Equinor',         lat: 61.3700, lng: 2.4700, type: 'oil-gas' },
  { name: 'Kvitebjørn',         operator: 'Equinor',         lat: 61.0833, lng: 2.5000, type: 'gas' },
  { name: 'Veslefrikk',         operator: 'Equinor',         lat: 60.7800, lng: 2.9000, type: 'oil-gas' },
  { name: 'Brage',              operator: 'OKEA',            lat: 60.5400, lng: 3.0500, type: 'oil' },
  { name: 'Oseberg A',          operator: 'Equinor',         lat: 60.5000, lng: 2.8167, type: 'oil-gas' },
  { name: 'Oseberg B',          operator: 'Equinor',         lat: 60.5500, lng: 2.8330, type: 'oil-gas' },
  { name: 'Oseberg C',          operator: 'Equinor',         lat: 60.6080, lng: 2.7800, type: 'oil-gas' },
  { name: 'Oseberg Sør',        operator: 'Equinor',         lat: 60.4500, lng: 2.7800, type: 'oil-gas' },
  { name: 'Troll A',            operator: 'Equinor',         lat: 60.6450, lng: 3.7200, type: 'gas' },
  { name: 'Troll B',            operator: 'Equinor',         lat: 60.7800, lng: 3.5050, type: 'oil-gas' },
  { name: 'Troll C',            operator: 'Equinor',         lat: 60.8870, lng: 3.6080, type: 'oil-gas' },

  // North Sea — Johan Sverdrup field
  { name: 'Johan Sverdrup',     operator: 'Equinor',         lat: 58.8500, lng: 2.5000, type: 'oil' },
  { name: 'Edvard Grieg',       operator: 'Aker BP',         lat: 58.8333, lng: 2.0833, type: 'oil' },
  { name: 'Ivar Aasen',         operator: 'Aker BP',         lat: 58.8800, lng: 2.1750, type: 'oil' },

  // Norwegian Sea (Haltenbanken)
  { name: 'Heidrun',            operator: 'Equinor',         lat: 65.3250, lng: 7.3170, type: 'oil-gas' },
  { name: 'Draugen',            operator: 'OKEA',            lat: 64.3500, lng: 7.7833, type: 'oil' },
  { name: 'Norne',              operator: 'Equinor',         lat: 66.0167, lng: 8.0833, type: 'oil-gas' },
  { name: 'Åsgard A',           operator: 'Equinor',         lat: 65.1130, lng: 6.7330, type: 'oil' },
  { name: 'Åsgard B',           operator: 'Equinor',         lat: 65.1130, lng: 6.7330, type: 'gas' },
  { name: 'Kristin',            operator: 'Equinor',         lat: 64.9930, lng: 6.5500, type: 'oil-gas' },
  { name: 'Njord',              operator: 'Equinor',         lat: 64.2667, lng: 7.2167, type: 'oil-gas' },
  { name: 'Skarv',              operator: 'Aker BP',         lat: 65.7000, lng: 7.5667, type: 'oil-gas' },
  { name: 'Ormen Lange',        operator: 'Shell',           lat: 63.5170, lng: 5.3500, type: 'gas' },

  // Barents Sea
  { name: 'Snøhvit',            operator: 'Equinor',         lat: 71.5500, lng: 21.6500, type: 'gas' },
  { name: 'Goliat',             operator: 'Vår Energi',      lat: 71.3000, lng: 22.2500, type: 'oil' },
  { name: 'Johan Castberg',     operator: 'Equinor',         lat: 72.5000, lng: 20.3000, type: 'oil' },
  { name: 'Aasta Hansteen',     operator: 'Equinor',         lat: 67.0830, lng: 7.0000, type: 'gas' },
]

const buildMapFence = (entries: ReadonlyArray<Platform>): string => {
  const features = entries.map(p => ({
    type: 'marker',
    lat: p.lat,
    lng: p.lng,
    label: `${p.name} (${p.operator})`,
    icon: 'platform',
  }))
  return '```map\n' + JSON.stringify({ features }, null, 2) + '\n```'
}

export const norwayPlatformsTool: Tool = {
  name: 'norway_platforms',
  description:
    'Returns a ```map fenced block of major Norwegian Continental Shelf oil & gas platforms. ' +
    'Paste the returned fence verbatim into your reply so the UI renders it inline.',
  usage: 'Call without arguments to render all ~50 platforms. Optional `filter` narrows by operator or platform-name substring (case-insensitive).',
  returns: 'A markdown string containing a single ```map fenced block.',
  parameters: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        description: 'Optional case-insensitive substring matched against platform name OR operator',
      },
    },
    additionalProperties: false,
  },
  execute: async (params): Promise<ToolResult> => {
    const filter = typeof params.filter === 'string' ? params.filter.trim().toLowerCase() : ''
    const subset = filter
      ? PLATFORMS.filter(p => p.name.toLowerCase().includes(filter) || p.operator.toLowerCase().includes(filter))
      : PLATFORMS
    if (subset.length === 0) {
      return { success: true, data: `No platforms matched filter "${filter}".` }
    }
    return { success: true, data: buildMapFence(subset) }
  },
}
