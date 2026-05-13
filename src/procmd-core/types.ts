// procmd-core — shared type surface for the procmd v0.6 parser.
//
// Consumed by:
//   - talkingAgents/src/packs/pwr-ops/procmd/parser.ts (re-export shim)
//   - talkingAgents/src/packs/pwr-ops/procmd/renderer.ts (procmd → agent markdown)
//   - pwr-ops/validate.ts (corpus-wide validator)
//   - pwr-ops/scripts/render-procmd.ts (procmd → MkDocs-flavored markdown)
//
// Spec: docs/procedure-md.md (v0.6 normative).
//
// The library exports only types, parsing, and version constants. Renderers
// and validators are each consumer's responsibility — they share semantics
// via ParsedProcedure but format output for different audiences.

export const PARSER_PROCMD_VERSION = '0.7'
export const ACCEPTED_PROCMD_VERSIONS = new Set(['0.7'])

export interface ParsedFrontmatter {
  readonly procedureId: string
  readonly title: string
  readonly procedureMd?: string
  readonly profile?: string
  readonly appliesTo?: string
  readonly category?: string
  readonly csfsMonitored: ReadonlyArray<string>
  readonly entryTriggers: ReadonlyArray<string>
  /** Frontmatter keys not consumed above, passed through verbatim as strings. */
  readonly extra: Readonly<Record<string, string>>
}

export type BranchTarget =
  | { readonly kind: 'intra'; readonly stepId: string }
  | { readonly kind: 'inter'; readonly procedureId: string }
  | { readonly kind: 'freeText'; readonly text: string }

export interface Branch {
  readonly condition: string
  readonly target: BranchTarget
  /** `Because:` rationale continuation line under the branch. */
  readonly because?: string
  /** `Against:` counter-rationale continuation line under the branch. */
  readonly against?: string
}

/**
 * v0.7 — multi-path diagnostic decision. The prologue describes what the
 * operator is identifying; numbered paths are the priority-ordered ways to
 * reach a conclusion. The actual transitions remain in the step's regular
 * `branches` (the step has both: paths are operator instructions, branches
 * are flow targets).
 */
export interface ParsedDecision {
  readonly prologue: string
  readonly paths: ReadonlyArray<string>
}

export interface ParsedStep {
  readonly id: string
  readonly label: string                       // display: "1", "3.a", etc
  readonly title: string                       // free text after the heading
  readonly checks: ReadonlyArray<string>
  readonly actions: ReadonlyArray<string>
  readonly cautions: ReadonlyArray<string>
  readonly notes: ReadonlyArray<string>
  readonly withins: ReadonlyArray<string>      // Within: time constraints
  /** v0.7 — present when the step uses the `Decision:` keyword */
  readonly decision?: ParsedDecision
  readonly tagsReferenced: ReadonlyArray<string>
  readonly branches: ReadonlyArray<Branch>
  /** True when branches.length > 0 OR a `Decision:` block is present. */
  readonly isDecision: boolean
}

export interface TagDefinition {
  readonly id: string
  readonly description?: string
  readonly simPath?: string
  readonly units?: string
  readonly equipment?: string
  /** Any other keys author declared (range, setpoint, source, …). */
  readonly extra: Readonly<Record<string, string>>
}

export interface ParsedProcedure {
  readonly frontmatter: ParsedFrontmatter
  readonly preamble: string
  /** CSF channels declared via standalone `CSF: <name>` lines in the preamble. */
  readonly csfChannels: ReadonlyArray<string>
  readonly steps: ReadonlyArray<ParsedStep>
  /** Structured `## Tags` appendix entries, in source order. */
  readonly tagDefinitions: ReadonlyArray<TagDefinition>
  readonly warnings: ReadonlyArray<string>
}

export type ParseResult = ParsedProcedure | { readonly error: string }

// === Scenario schema (Phase F.0) ===========================================
//
// Scenarios bridge procedures to simulator input. Each scenario file lives
// in `wiki/scenarios/*.md` with simple frontmatter and three structured
// body sections, each a fenced JSON code block. Authors get readable
// markdown source; the parser gets unambiguous structured data without a
// YAML dependency.
//
// Expected file layout:
//
//     ---
//     type: scenario
//     scenario-id: sb-loca
//     title: Small-break LOCA
//     ---
//
//     Prose preamble describing the scenario.
//
//     ## Initial state
//     ```json
//     { "PT-455": 2235, "SG-A-LVL-NR": 50 }
//     ```
//
//     ## Injections
//     ```json
//     [{ "tag": "PT-455", "value": 1600, "at-time-s": 30 }]
//     ```
//
//     ## Expected traversal
//     ```json
//     ["E-0#verify-reactor-trip", "E-1#start-hhsi"]
//     ```
//
//     ## Expected terminal state
//     ```json
//     { "RHR-PUMP-A": "RUN" }
//     ```

export interface ScenarioInjection {
  readonly tag: string
  readonly value: string | number | boolean
  readonly atTimeS: number
}

export type EalClass = 'UE' | 'Alert' | 'SAE' | 'GE'

export interface ParsedScenario {
  readonly scenarioId: string
  readonly title: string
  readonly preamble: string
  readonly initialState: Readonly<Record<string, string | number | boolean>>
  readonly injections: ReadonlyArray<ScenarioInjection>
  /** Ordered list of `<procedure-id>#<step-id>` refs the scenario expects to traverse. */
  readonly expectedTraversal: ReadonlyArray<string>
  readonly expectedTerminalState: Readonly<Record<string, string | number | boolean>>
  /**
   * F.1 — declared expected highest EAL class reached over the scenario
   * timeline. Validator runs eal_classify against the scenario and errors
   * on mismatch. Required field for v1.
   */
  readonly expectedEalClass: EalClass
  /**
   * F.2 — source for the scenario timing data. Either a UFSAR section
   * reference (e.g. "Vogtle UFSAR §15.6.5") or the literal "synthetic".
   * Validator emits a warning at deploy time on synthetic timing so the
   * synthetic count is visible.
   */
  readonly timingSource: string
  readonly warnings: ReadonlyArray<string>
}

export type ScenarioParseResult = ParsedScenario | { readonly error: string }
