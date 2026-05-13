// procmd-core public API.
//
// Spec: docs/procedure-md.md (v0.6 normative).
//
// This is the single source of truth for procmd parsing. It is vendored
// into the pwr-ops wiki repo under `procmd-core/` with a SHA pin in
// `procmd-core.sha`. Both samsinn and the wiki repo (validate.ts +
// scripts/render-procmd.ts) import from here.

export { parseProcedure, PARSER_PROCMD_VERSION, ACCEPTED_PROCMD_VERSIONS } from './parser.ts'
export { parseScenario } from './scenario-parser.ts'
export {
  parsePredicate,
  evalPredicateOverTimeSeries,
  projectScenarioTimeline,
  classifyEal,
  tagsInPredicate,
} from './eal-predicate.ts'
export type {
  Branch,
  BranchTarget,
  EalClass,
  ParsedDecision,
  ParsedFrontmatter,
  ParsedProcedure,
  ParsedScenario,
  ParsedStep,
  ParseResult,
  ScenarioInjection,
  ScenarioParseResult,
  TagDefinition,
} from './types.ts'
export type {
  EalClassificationResult,
  EalRule,
  EalRulesFile,
  Predicate,
  PredicateAtom,
  PredicateBoolean,
  PredicateOp,
  PredicateParseError,
  PredicateParseResult,
  ProjectedSample,
} from './eal-predicate.ts'
