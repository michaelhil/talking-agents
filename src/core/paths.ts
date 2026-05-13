// ============================================================================
// Filesystem layout — one source of truth for every persistent path Samsinn
// uses on disk. Paths are functions (not constants) so SAMSINN_HOME can be
// overridden per-test or per-deploy, including in tests that mock homedir().
//
// Layout:
//   $SAMSINN_HOME/                              ← global / shared
//     providers.json                            ← provider keys + order
//     packs/                                    ← installed packs (shared)
//       <namespace>/                            ← third-party packs
//       local/                                  ← user's drop-in dirs
//         tools/                                ← drop-in TS tools
//         skills/<name>/                        ← drop-in skills
//         scripts/*.md                          ← drop-in scripts
//         geodata/<category>.geojson            ← user-paste geodata
//     geodata/.bundled/<version>/               ← cached samsinn-geodata snapshot (NOT user data)
//     knowledge/                                ← shared knowledge files
//     logs/admin.jsonl                          ← janitor + registry events
//     instances/                                ← per-instance state
//       <id>/
//         snapshot.json
//         logs/*.jsonl
//         memory/<agentName>/{notes.log,facts.json}
//       .trash/
//         <id>-<unix-ts>/                       ← evicted/reset, kept 7 days
//     .local-pack-migrated                      ← sentinel: drop-in dirs
//                                                  moved into packs/local/
//                                                  (commit P, one-shot)
//
// SAMSINN_HOME defaults to ~/.samsinn (preserves existing single-tenant UX).
// ============================================================================

import { homedir } from 'node:os'
import { join } from 'node:path'

export const samsinnHome = (): string =>
  process.env.SAMSINN_HOME && process.env.SAMSINN_HOME.length > 0
    ? process.env.SAMSINN_HOME
    : join(homedir(), '.samsinn')

// Shared (global) paths — registries, configs, packs dirs.
//
// Drop-in dirs (tools/skills/scripts/geodata) live INSIDE the synthetic
// 'local' pack at packs/local/<subdir>/ since commit P. The migration
// at boot moves them from their old top-level locations idempotently.
// See migrate-local-pack.ts.
const localPack = (): string => join(samsinnHome(), 'packs', 'local')

export const sharedPaths = {
  root: (): string => samsinnHome(),
  providers: (): string => join(samsinnHome(), 'providers.json'),
  llmPolicy: (): string => join(samsinnHome(), 'llm-policy.json'),
  packs: (): string => join(samsinnHome(), 'packs'),
  skills: (): string => join(localPack(), 'skills'),
  scripts: (): string => join(localPack(), 'scripts'),
  tools: (): string => join(localPack(), 'tools'),
  knowledge: (): string => join(samsinnHome(), 'knowledge'),
  geodata: (): string => join(localPack(), 'geodata'),
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
  // Per-instance vector index (RAG). Single JSONL file with header,
  // vectors, and tombstones. See src/embed/vector-store.ts.
  readonly vectors: string
}

export const instancePaths = (id: string): InstancePaths => {
  assertValidInstanceId(id)
  const root = join(samsinnHome(), 'instances', id)
  return {
    root,
    snapshot: join(root, 'snapshot.json'),
    logs: join(root, 'logs'),
    memory: join(root, 'memory'),
    vectors: join(root, 'vectors.jsonl'),
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
