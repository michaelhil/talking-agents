// ============================================================================
// Demo catalog — static data driving the empty-room demo strip and the
// demo modal. Each demo is a small bundle of click-to-send prompts plus the
// packs the prompts depend on (merged into the room's active set on launch).
//
// Adding a new demo: add an entry below. The strip/modal/header-icon all
// derive from this array — no other edits needed.
// ============================================================================

export interface DemoPrompt {
  readonly label: string
  readonly description: string
  // Sent verbatim as a chat message in the current room when clicked.
  // Mention any required tool by name explicitly; modern models pick tools
  // reliably when named.
  readonly prompt: string
}

export type DemoId = 'procedures' | 'biometrics' | 'aviation'

export interface Demo {
  readonly id: DemoId
  readonly title: string
  readonly blurb: string                       // shown in the modal; mentions the 🪄 icon
  readonly requiredPacks: ReadonlyArray<string>
  // Tool names the prompts call. A boot-time test (catalog.test.ts) asserts
  // each is registered so silent demo-breakage from tool renames is caught.
  readonly requiredTools: ReadonlyArray<string>
  readonly prompts: ReadonlyArray<DemoPrompt>
}

export const DEMO_CATALOG: ReadonlyArray<Demo> = [
  {
    id: 'procedures',
    title: 'Procedure Demo',
    blurb:
      'Pull real nuclear-plant emergency operating procedures from the wiki, search across them by keyword, and classify scenarios against NEI 99-01 emergency action levels. Click any prompt below to try it. You can re-open this list any time from the 🪄 icon in the room header.',
    requiredPacks: ['pwr-ops'],
    requiredTools: ['procedure_lookup', 'procedure_search', 'wiki_lookup', 'eal_classify'],
    prompts: [
      {
        label: 'Fetch E-0 + flowchart',
        description: 'Show procedure E-0 as a numbered step list plus a mermaid decision flowchart.',
        prompt: 'Use the procedure_lookup tool to fetch procedure E-0 and show me a numbered step list plus a mermaid flowchart of the decision flow.',
      },
      {
        label: 'Search "loss of coolant"',
        description: 'BM25 keyword search across all EOPs for matching procedures.',
        prompt: 'Use the procedure_search tool to search the procedure wiki for "loss of coolant" and show me the top 5 matches with their titles and brief snippets.',
      },
      {
        label: 'EAL classify SGTR',
        description: 'Classify a steam-generator-tube-rupture scenario against NEI 99-01 EALs.',
        prompt: 'Use the eal_classify tool to classify a scenario where a steam generator tube rupture (SGTR) is detected with primary-to-secondary leakage of 50 gpm. What EAL class does this map to?',
      },
      {
        label: 'Reference: Tag catalogue index',
        description: 'Fetch a wiki reference page (not a procedure) — the tag-catalogue index.',
        prompt: 'Use the wiki_lookup tool with type "tag-catalogue" and id "index" to fetch the tag-catalogue index, then summarise what systems are covered and what each entry represents.',
      },
    ],
  },
  {
    id: 'biometrics',
    title: 'Biometrics Demo',
    blurb:
      'Webcam-based attention tracking. The agent observes your face for a moment, narrates what it sees, then releases the camera. You\'ll be asked to consent to webcam access the first time. Re-open this list any time from the 🪄 icon in the room header.',
    requiredPacks: ['biometrics'],
    requiredTools: ['biometrics_start', 'biometrics_read', 'biometrics_stop'],
    prompts: [
      {
        label: 'Watch me',
        description: 'Agent starts the camera, reads one frame, narrates, and stops.',
        prompt: 'Watch me for a moment using the biometrics tools, then tell me what you see — attention level, dominant expression, anything notable. Use biometrics_start, then biometrics_read with the captureId you got, then biometrics_stop with the same captureId.',
      },
      {
        label: 'Coach my focus',
        description: 'Agent observes and offers one piece of concrete focus advice.',
        prompt: 'Use the biometrics tools to observe me for a moment, then give me one concrete piece of advice for staying focused based on what you see. One reading, one observation, one tip.',
      },
      {
        label: 'Quick check',
        description: 'Just a quick glance — am I still here?',
        prompt: 'Use biometrics_start, biometrics_read, then biometrics_stop to quickly check whether I\'m still at my desk and looking attentive. One sentence reply.',
      },
    ],
  },
  {
    id: 'aviation',
    title: 'Aviation Demo',
    blurb:
      'Live VATSIM network data — real human pilots flying simulators right now — plus offshore platform geodata, rendered on an inline map. Re-open this list any time from the 🪄 icon in the room header.',
    requiredPacks: ['demos'],
    requiredTools: ['vatsim_arrivals', 'norway_platforms'],
    prompts: [
      {
        label: 'Arrivals into Heathrow',
        description: 'Live VATSIM arrivals to EGLL on a map.',
        prompt: 'Use the vatsim_arrivals tool with ICAO EGLL and show me live arrivals to London Heathrow on a map.',
      },
      {
        label: 'Arrivals into JFK',
        description: 'Live VATSIM arrivals to KJFK on a map.',
        prompt: 'Use the vatsim_arrivals tool with ICAO KJFK and show me live arrivals to New York JFK on a map.',
      },
      {
        label: 'Norwegian oil platforms',
        description: 'Every major NCS platform plotted on a map.',
        prompt: 'Use the norway_platforms tool and show me all major Norwegian Continental Shelf oil & gas platforms on a map.',
      },
      {
        label: 'Arrivals into Oslo',
        description: 'Live VATSIM arrivals to ENGM on a map.',
        prompt: 'Use the vatsim_arrivals tool with ICAO ENGM and show me live arrivals to Oslo Gardermoen on a map.',
      },
    ],
  },
]

export const getDemo = (id: string): Demo | undefined =>
  DEMO_CATALOG.find(d => d.id === id)
