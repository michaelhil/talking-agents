// Pack loader — orchestrates loading one or many packs under ~/.samsinn/packs.
//
// A pack is a directory that may contain:
//   - pack.json              (optional manifest; name + description)
//   - tools/*.ts             (tools, namespaced as `<pack>_<name>`)
//   - skills/<name>/SKILL.md (skills, namespaced as `<pack>/<name>`)
//
// Tool conflicts across packs are physically impossible thanks to the
// namespace prefix. A pack tool cannot shadow a built-in (built-ins stay
// unprefixed).

import type { Pack } from './types.ts'
import type { ToolRegistry } from '../core/types/tool.ts'
import type { SkillStore } from '../skills/loader.ts'
import { loadToolDirectory } from '../tools/loader.ts'
import { loadSkills } from '../skills/loader.ts'
import { scanPacks } from './scanner.ts'
import { join } from 'node:path'

export interface PackLoadResult {
  readonly pack: Pack
  readonly tools: ReadonlyArray<string>   // registry keys (prefixed)
  readonly skills: ReadonlyArray<string>  // registry keys (prefixed)
  readonly errors: ReadonlyArray<string>
}

export const loadPack = async (
  pack: Pack,
  toolRegistry: ToolRegistry,
  skillStore: SkillStore,
): Promise<PackLoadResult> => {
  const errors: string[] = []

  const toolResult = await loadToolDirectory(join(pack.dirPath, 'tools'), toolRegistry, {
    kind: 'pack-bundled',
    pack: pack.namespace,
    namespacePrefix: pack.namespace,
  })
  for (const e of toolResult.errors) errors.push(`${pack.namespace}/tools: ${e}`)

  const skillResult = await loadSkills(join(pack.dirPath, 'skills'), skillStore, toolRegistry, {
    namespacePrefix: pack.namespace,
    pack: pack.namespace,
  })
  for (const e of skillResult.errors) errors.push(`${pack.namespace}/skills: ${e}`)

  return {
    pack,
    tools: toolResult.loaded,
    skills: skillResult.loaded,
    errors,
  }
}

export const loadAllPacks = async (
  packsRoot: string,
  toolRegistry: ToolRegistry,
  skillStore: SkillStore,
): Promise<ReadonlyArray<PackLoadResult>> => {
  const packs = await scanPacks(packsRoot)
  const results: PackLoadResult[] = []
  for (const pack of packs) {
    results.push(await loadPack(pack, toolRegistry, skillStore))
  }
  if (results.length > 0) {
    const totals = results.reduce(
      (acc, r) => ({
        packs: acc.packs + 1,
        tools: acc.tools + r.tools.length,
        skills: acc.skills + r.skills.length,
      }),
      { packs: 0, tools: 0, skills: 0 },
    )
    console.log(`[packs] ${totals.packs} packs loaded (${totals.tools} tools, ${totals.skills} skills)`)
  }
  return results
}
