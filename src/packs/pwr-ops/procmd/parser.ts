// procmd v0.6 parser — re-export shim over procmd-core.
//
// The actual parser lives in src/procmd-core/. This shim preserves the
// pack-relative import path that pack consumers (renderer.ts, the tool,
// and tests) use today. Future internal refactors can collapse the shim
// by importing from `../../../procmd-core/index.ts` directly.

export {
  parseProcedure,
  PARSER_PROCMD_VERSION,
  ACCEPTED_PROCMD_VERSIONS,
} from '../../../procmd-core/index.ts'

export type {
  Branch,
  BranchTarget,
  ParsedFrontmatter,
  ParsedProcedure,
  ParsedStep,
  ParseResult,
  TagDefinition,
} from '../../../procmd-core/index.ts'
