// Integration tests for pack-tools — install / update / uninstall / list.
// Uses a real local git repo as the source and file:// as the transport,
// so nothing leaves the machine.

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import {
  createInstallPackTool, createUpdatePackTool,
  createUninstallPackTool, createListPacksTool,
  type PackToolsDeps,
} from './pack-tools.ts'
import { createToolRegistry } from '../../core/tool-registry.ts'
import { createSkillStore } from '../../skills/loader.ts'
import type { ToolContext } from '../../core/types/tool.ts'

const CTX: ToolContext = { callerId: 'test', callerName: 'test' }

const TOOL_SRC = (name: string) => `
export default {
  name: '${name}',
  description: 'test tool ${name}',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ success: true, data: '${name}' }),
}
`

const SKILL_MD = (name: string) => `---
name: ${name}
description: test skill ${name}
---

Body.
`

// Build a bare git repo with one tool + one skill. Returns the file:// URL
// pointing at the repo; clients clone from there.
const buildRepo = async (parent: string, name: string): Promise<string> => {
  const repoDir = join(parent, `${name}-src`)
  await mkdir(join(repoDir, 'tools'), { recursive: true })
  await mkdir(join(repoDir, 'skills', 'demo'), { recursive: true })
  await writeFile(join(repoDir, 'tools', 'ping.ts'), TOOL_SRC('ping'))
  await writeFile(join(repoDir, 'skills', 'demo', 'SKILL.md'), SKILL_MD('demo'))
  await writeFile(join(repoDir, 'pack.json'), JSON.stringify({
    name, description: `Test pack ${name}`,
  }))
  await $`git -C ${repoDir} init -q`.quiet()
  await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
  await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m init`.quiet()
  return `file://${repoDir}`
}

const makeDeps = async (): Promise<{ deps: PackToolsDeps; parent: string; refreshCount: { n: number } }> => {
  const parent = await mkdtemp(join(tmpdir(), 'pack-tools-'))
  const packsDir = join(parent, 'packs')
  await mkdir(packsDir, { recursive: true })
  const refreshCount = { n: 0 }
  const deps: PackToolsDeps = {
    packsDir,
    toolRegistry: createToolRegistry(),
    skillStore: createSkillStore(),
    refreshAllAgentTools: async () => { refreshCount.n += 1 },
  }
  return { deps, parent, refreshCount }
}

describe('install_pack', () => {
  let parent: string

  afterEach(async () => {
    if (parent) await rm(parent, { recursive: true, force: true })
  })

  it('clones, namespaces from manifest, registers — and calls refreshAllAgentTools', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')

    const install = createInstallPackTool(env.deps)
    const result = await install.execute({ source: url }, CTX)

    expect(result.success).toBe(true)
    const data = result.data as { namespace: string; tools: string[]; skills: string[] }
    // pack.json `name: "atc"` is authoritative — wins over the source dir
    // basename ("atc-src"). Phase A: manifest.name is the single source of
    // truth for the install namespace.
    expect(data.namespace).toBe('atc')
    expect(data.tools).toEqual(['atc_ping'])
    expect(data.skills).toEqual(['atc/demo'])
    expect(env.deps.toolRegistry.has('atc_ping')).toBe(true)
    expect(env.deps.skillStore.get('atc/demo')).toBeDefined()
    expect(env.refreshCount.n).toBe(1)
  })

  it('respects explicit name override', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')

    const install = createInstallPackTool(env.deps)
    const result = await install.execute({ source: url, name: 'atc' }, CTX)

    expect(result.success).toBe(true)
    expect(env.deps.toolRegistry.has('atc_ping')).toBe(true)
    expect(env.deps.toolRegistry.has('atc-src_ping')).toBe(false)
  })

  it('refuses to overwrite existing install', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')

    const install = createInstallPackTool(env.deps)
    await install.execute({ source: url, name: 'atc' }, CTX)
    const second = await install.execute({ source: url, name: 'atc' }, CTX)
    expect(second.success).toBe(false)
    expect(second.error).toContain('already installed')
  })

  it('reports a clear error for invalid source', async () => {
    const env = await makeDeps()
    parent = env.parent
    const install = createInstallPackTool(env.deps)
    const result = await install.execute({ source: 'has.dots' }, CTX)
    expect(result.success).toBe(false)
  })

  it('refuses to install "core" — bundled with the binary, not pack-installable', async () => {
    const env = await makeDeps()
    parent = env.parent
    const install = createInstallPackTool(env.deps)

    // Bare-name attempt
    const bare = await install.execute({ source: 'core' }, CTX)
    expect(bare.success).toBe(false)
    expect(bare.error).toContain('bundled')

    // Owner/repo attempt against the public mirror
    const ownerRepo = await install.execute({ source: 'michaelhil/samsinn-core' }, CTX)
    expect(ownerRepo.success).toBe(false)
    expect(ownerRepo.error).toContain('bundled')

    // Full URL attempt
    const url = await install.execute({ source: 'https://github.com/michaelhil/samsinn-core.git' }, CTX)
    expect(url.success).toBe(false)
    expect(url.error).toContain('bundled')

    // Override with name=core, even when source looks like a real third-party pack
    const override = await install.execute({ source: 'someone-else/their-pack', name: 'core' }, CTX)
    expect(override.success).toBe(false)
    expect(override.error).toContain('bundled')
  })

  it('reports git failure without leaving a stray directory', async () => {
    const env = await makeDeps()
    parent = env.parent
    const install = createInstallPackTool(env.deps)
    // file:// to a non-existent repo
    const result = await install.execute({
      source: `file://${env.parent}/does-not-exist`,
      name: 'ghost',
    }, CTX)
    expect(result.success).toBe(false)

    const { stat } = await import('node:fs/promises')
    let stillThere = false
    try {
      await stat(join(env.deps.packsDir, 'ghost'))
      stillThere = true
    } catch { /* expected */ }
    expect(stillThere).toBe(false)
  })
})

describe('uninstall_pack', () => {
  let parent: string
  afterEach(async () => { if (parent) await rm(parent, { recursive: true, force: true }) })

  it('unregisters tools + skills and removes the directory', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')

    const install = createInstallPackTool(env.deps)
    const uninstall = createUninstallPackTool(env.deps)
    await install.execute({ source: url, name: 'atc' }, CTX)
    expect(env.deps.toolRegistry.has('atc_ping')).toBe(true)

    const result = await uninstall.execute({ name: 'atc' }, CTX)
    expect(result.success).toBe(true)
    expect(env.deps.toolRegistry.has('atc_ping')).toBe(false)
    expect(env.deps.skillStore.get('atc/demo')).toBeUndefined()
    expect(env.refreshCount.n).toBe(2) // install + uninstall

    const { stat } = await import('node:fs/promises')
    let stillThere = false
    try { await stat(join(env.deps.packsDir, 'atc')); stillThere = true } catch { /* expected */ }
    expect(stillThere).toBe(false)
  })

  it('refuses when pack is not installed', async () => {
    const env = await makeDeps()
    parent = env.parent
    const uninstall = createUninstallPackTool(env.deps)
    const result = await uninstall.execute({ name: 'nope' }, CTX)
    expect(result.success).toBe(false)
  })

  it('scrubs pack from rooms.activePacks atomically before tearing down registry', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')

    // Track scrubbed rooms via the wired callback. Mirrors what
    // bootstrap.ts plumbs as crossInstanceScrubActivePacks.
    const fakeRooms = new Map<string, string[]>([
      ['room-a', ['atc', 'cafes']],
      ['room-b', ['atc']],
      ['room-c', ['cafes']],            // doesn't have atc — should NOT appear in scrub list
    ])
    const scrubbed: { roomId: string; activePacks: ReadonlyArray<string> }[] = []
    const depsWithScrub: PackToolsDeps = {
      ...env.deps,
      scrubActivePacks: (ns: string) => {
        for (const [roomId, packs] of fakeRooms) {
          if (!packs.includes(ns)) continue
          const next = packs.filter(p => p !== ns)
          fakeRooms.set(roomId, next)
          scrubbed.push({ roomId, activePacks: next })
        }
        return scrubbed
      },
    }

    const install = createInstallPackTool(depsWithScrub)
    const uninstall = createUninstallPackTool(depsWithScrub)
    await install.execute({ source: url, name: 'atc' }, CTX)

    const result = await uninstall.execute({ name: 'atc' }, CTX)
    expect(result.success).toBe(true)
    // Two rooms had atc active; one didn't — only the affected two
    // are reported.
    expect(scrubbed.map(s => s.roomId).sort()).toEqual(['room-a', 'room-b'])
    expect(fakeRooms.get('room-a')).toEqual(['cafes'])
    expect(fakeRooms.get('room-b')).toEqual([])
    expect(fakeRooms.get('room-c')).toEqual(['cafes']) // untouched
    // Result body carries the audit list for the WS broadcast layer.
    expect((result.data as { scrubbedRooms: unknown }).scrubbedRooms).toEqual(scrubbed)
  })
})

describe('update_pack', () => {
  let parent: string
  afterEach(async () => { if (parent) await rm(parent, { recursive: true, force: true }) })

  it('pulls new commits and re-registers pack contents', async () => {
    const env = await makeDeps()
    parent = env.parent
    const repoDir = join(env.parent, 'atc-source')
    await mkdir(join(repoDir, 'tools'), { recursive: true })
    await writeFile(join(repoDir, 'tools', 'a.ts'), TOOL_SRC('a'))
    await writeFile(join(repoDir, 'pack.json'), JSON.stringify({ name: 'atc' }))
    await $`git -C ${repoDir} init -q`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m init`.quiet()
    // Ensure branch name is predictable.
    await $`git -C ${repoDir} branch -M main`.quiet().nothrow()

    const install = createInstallPackTool(env.deps)
    await install.execute({ source: `file://${repoDir}`, name: 'atc' }, CTX)
    expect(env.deps.toolRegistry.has('atc_a')).toBe(true)

    // Add a new tool upstream.
    await writeFile(join(repoDir, 'tools', 'b.ts'), TOOL_SRC('b'))
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t add .`.quiet()
    await $`git -C ${repoDir} -c user.email=t@t -c user.name=t commit -q -m add-b`.quiet()

    const update = createUpdatePackTool(env.deps)
    const result = await update.execute({ name: 'atc' }, CTX)
    expect(result.success).toBe(true)
    expect(env.deps.toolRegistry.has('atc_a')).toBe(true)
    expect(env.deps.toolRegistry.has('atc_b')).toBe(true)
  })
})

describe('list_packs', () => {
  let parent: string
  afterEach(async () => { if (parent) await rm(parent, { recursive: true, force: true }) })

  it('returns installed packs with their tool/skill keys, prefixed by synthetic system packs', async () => {
    const env = await makeDeps()
    parent = env.parent
    const url = await buildRepo(env.parent, 'atc')
    await createInstallPackTool(env.deps).execute({ source: url, name: 'atc' }, CTX)

    const list = createListPacksTool(env.deps)
    const result = await list.execute({}, CTX)
    expect(result.success).toBe(true)
    const data = result.data as Array<{
      namespace: string
      tools: string[]
      skills: string[]
      system?: boolean
    }>

    // Two synthetic system packs (core, local) followed by the installed
    // 'atc' pack. System packs are first so the UI surfaces the always-on
    // baseline before user-controlled entries.
    expect(data.map(p => p.namespace)).toEqual(['core', 'local', 'atc'])

    expect(data[0]?.system).toBe(true)
    expect(data[1]?.system).toBe(true)
    expect(data[2]?.system).toBe(false)

    // The installed pack reports its own tools/skills correctly.
    expect(data[2]?.namespace).toBe('atc')
    expect(data[2]?.tools).toEqual(['atc_ping'])
    expect(data[2]?.skills).toEqual(['atc/demo'])

    // System pack tool/skill counts depend on what the test's tool registry
    // contains — makeDeps doesn't pre-load built-ins or external dropins,
    // so core/local should be empty here. (Production has the full set.)
    expect(data[0]?.tools).toEqual([])
    expect(data[0]?.skills).toEqual([])
    expect(data[1]?.tools).toEqual([])
    expect(data[1]?.skills).toEqual([])
  })
})
