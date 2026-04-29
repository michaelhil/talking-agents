// ============================================================================
// Filesystem layout — one source of truth for every persistent path Samsinn
// uses on disk. Paths are functions (not constants) so SAMSINN_HOME can be
// overridden per-test or per-deploy, including in tests that mock homedir().
//
// Layout:
//   $SAMSINN_HOME/                              ← global / shared
//     providers.json                            ← provider keys + order
//     packs/<namespace>/                        ← installed packs (shared)
//     skills/<name>/                            ← global skills
//     tools/                                    ← drop-in TS tools
//     knowledge/                                ← shared knowledge files
//     logs/admin.jsonl                          ← janitor + registry events
//     instances/                                ← per-instance state
//       <id>/
//         snapshot.json
//         logs/*.jsonl
//         memory/<agentName>/{notes.log,facts.json}
//       .trash/
//         <id>-<unix-ts>/                       ← evicted/reset, kept 7 days
//
// SAMSINN_HOME defaults to ~/.samsinn (preserves existing single-tenant UX).
// ============================================================================

import { homedir } from 'node:os'
import { join } from 'node:path'

export const samsinnHome = (): string =>
  process.env.SAMSINN_HOME && process.env.SAMSINN_HOME.length > 0
    ? process.env.SAMSINN_HOME
    : join(homedir(), '.samsinn')

// Shared (global) paths — registries, configs, packs/skills/tools dirs.
export const sharedPaths = {
  root: (): string => samsinnHome(),
  providers: (): string => join(samsinnHome(), 'providers.json'),
  wikis: (): string => join(samsinnHome(), 'wikis.json'),
  packs: (): string => join(samsinnHome(), 'packs'),
  skills: (): string => join(samsinnHome(), 'skills'),
  scripts: (): string => join(samsinnHome(), 'scripts'),
  tools: (): string => join(samsinnHome(), 'tools'),
  knowledge: (): string => join(samsinnHome(), 'knowledge'),
  // Legacy global memory dir. Moves to per-instance in Phase I; keep for
  // now so single-tenant agents keep their notes.log/facts.json.
  memoryLegacy: (): string => join(samsinnHome(), 'memory'),
  adminLog: (): string => join(samsinnHome(), 'logs', 'admin.jsonl'),
  instancesRoot: (): string => join(samsinnHome(), 'instances'),
  trashRoot: (): string => join(samsinnHome(), 'instances', '.trash'),
}

// Per-instance paths — derive from a 16-char base32-lowercase ID. The
// validateInstanceId guard keeps callers honest at the boundary.
export interface InstancePaths {
  readonly root: string
  readonly snapshot: string
  readonly logs: string
  readonly memory: string
}

export const instancePaths = (id: string): InstancePaths => {
  assertValidInstanceId(id)
  const root = join(samsinnHome(), 'instances', id)
  return {
    root,
    snapshot: join(root, 'snapshot.json'),
    logs: join(root, 'logs'),
    memory: join(root, 'memory'),
  }
}

// Trash path for an evicted/reset instance. Timestamp suffix prevents
// collisions if the same id is reset multiple times.
export const trashPath = (id: string, now: number = Date.now()): string => {
  assertValidInstanceId(id)
  return join(samsinnHome(), 'instances', '.trash', `${id}-${now}`)
}

// Validate an instance ID — 16 chars, lowercase alphanumeric. Used at the
// boundary (cookie, ?join=, ?instance=) to refuse anything else before it
// reaches the filesystem.
const ID_PATTERN = /^[a-z0-9]{16}$/
export const isValidInstanceId = (id: string): boolean => ID_PATTERN.test(id)

// Defense-in-depth: throws if a caller bypassed the boundary check. Cheap
// guard that prevents accidental path traversal if any future call site
// forgets to validate before passing into instancePaths/trashPath.
export const assertValidInstanceId = (id: string): void => {
  if (!isValidInstanceId(id)) {
    throw new Error(`invalid instance id: ${JSON.stringify(id)} (expected 16-char lowercase alphanumeric)`)
  }
}
