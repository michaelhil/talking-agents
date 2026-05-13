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

export const PARSER_PROCMD_VERSION = '0.6'
export const ACCEPTED_PROCMD_VERSIONS = new Set(['0.6'])

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

export interface ParsedStep {
  readonly id: string
  readonly label: string                       // display: "1", "3.a", etc
  readonly title: string                       // free text after the heading
  readonly checks: ReadonlyArray<string>
  readonly actions: ReadonlyArray<string>
  readonly cautions: ReadonlyArray<string>
  readonly notes: ReadonlyArray<string>
  readonly withins: ReadonlyArray<string>      // Within: time constraints
  readonly tagsReferenced: ReadonlyArray<string>
  readonly branches: ReadonlyArray<Branch>
  readonly isDecision: boolean                 // has at least one branch
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
