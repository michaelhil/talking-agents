// ============================================================================
// Pack admin tools — install / update / uninstall / list packs from GitHub.
//
// A pack is a git-cloned directory under ~/.samsinn/packs/<ns>/ with optional
// pack.json plus tools/ and skills/ subdirs. The namespace is the directory
// basename; it prefixes all registered tools (`<ns>_<tool>`) and skills
// (`<ns>/<skill>`) to eliminate cross-pack name collisions.
//
// Canonical namespace resolution (single source of truth):
//   1. pack.json `name` (validated against VALID_NS)
//   2. samsinn-pack-stripped basename of the source repo
//   3. caller's optional `name` override (always wins if provided)
//
// install_pack source forms:
//   - bare name `X`     → resolved against the registry (see registry.ts).
//                         No more "default org" guess — if X isn't in the
//                         registry, the call errors out.
//   - "user/repo"       → github.com/user/repo.git
//   - full URL          → cloned as-is (https://, ssh, file://, ...)
//
// Install flow: clone to a temp dir, read the manifest, resolve the canonical
// namespace, then move the temp dir to the final path. This means the FINAL
// directory name always matches the canonical namespace — so scanner-derived
// basename == registered tool/skill prefix == registry name. One source of
// truth, no prefix-stripping shims downstream.
//
// All shell-outs go through `Bun.$` tagged-template form so arguments are
// quoted correctly — never string-concatenated.
// ============================================================================

import type { Tool, ToolRegistry } from '../../core/types/tool.ts'
import type { SkillStore } from '../../skills/loader.ts'
import { loadPack } from '../../packs/loader.ts'
import { readManifest, resolveInstallNamespace, stripPackPrefix } from '../../packs/manifest.ts'
import { scanPacks } from '../../packs/scanner.ts'
import { getAvailablePacks } from '../../packs/registry.ts'
import { stat, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { $ } from 'bun'

// Pack namespaces are directory names — same regex as tool/skill names.
const VALID_NS = /^[a-zA-Z0-9_-]+$/

type RefreshAllFn = () => Promise<void>

// Optional callback the host wires up to broadcast a system note to every
// room with AI agents whenever a pack's tools change. Without this, an
// agent that previously logged "tool unavailable" before a fix went in keeps
// its polluted chat history and pattern-matches against it on next turn,
// even though the tool now exists. The system note in-history breaks the
// pattern.
export type NotifyPacksChanged = (info: {
  readonly action: 'installed' | 'updated' | 'uninstalled'
  readonly namespace: string
  readonly tools: ReadonlyArray<string>
  readonly skills: ReadonlyArray<string>
}) => void

export interface PackToolsDeps {
  readonly packsDir: string
  readonly toolRegistry: ToolRegistry
  readonly skillStore: SkillStore
  readonly refreshAllAgentTools: RefreshAllFn
  readonly notifyPacksChanged?: NotifyPacksChanged
}

// --- URL resolution ---
//
// resolveSource handles URL + user/repo forms. Bare names are resolved
// separately via the registry — see resolveBareName below. Splitting the two
// keeps URL parsing synchronous (no I/O) and forces the bare-name path to
// surface a clear error when the registry has no match.

interface ResolvedUrl {
  readonly url: string
  readonly sourceLabel: string   // basename used as the install fallback
}

const basenameFromUrl = (url: string): string => {
  const withoutGit = url.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const parts = withoutGit.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

const resolveSource = (source: string): ResolvedUrl | { error: string } => {
  const s = source.trim()
  if (!s) return { error: 'source is required' }

  // Full URL (anything with a scheme or @ for ssh).
  if (/^(https?:|ssh:|git:|file:)/i.test(s) || s.includes('@')) {
    const base = basenameFromUrl(s)
    if (!base) return { error: `Cannot derive a name from URL "${s}" — pass an explicit \`name\`` }
    return { url: s, sourceLabel: base }
  }

  // user/repo shorthand.
  if (s.includes('/')) {
    const parts = s.split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { error: `Invalid shorthand "${s}" — expected "user/repo"` }
    }
    return { url: `https://github.com/${parts[0]}/${parts[1]}.git`, sourceLabel: parts[1] }
  }

  // Bare names are not handled here — see resolveBareName.
  return { error: `Bare-name resolution requires the registry; got "${s}". Use \`user/repo\` or a full URL, or call list_available_packs to see what's available.` }
}

// Look up a bare name in the configured registry. Match by canonical name
// (registry already strips `samsinn-pack-` from repo names, see registry.ts)
// OR by the full repo basename — both forms are accepted so an agent that
// remembers either spelling resolves the same pack.
const resolveBareName = async (bareName: string): Promise<ResolvedUrl | { error: string }> => {
  if (!VALID_NS.test(bareName)) {
    return { error: `Invalid pack name "${bareName}" — use letters, digits, underscores, hyphens` }
  }
  let available
  try {
    available = await getAvailablePacks()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { error: `Could not consult pack registry: ${reason}` }
  }
  const match = available.find(
    p => p.name === bareName || stripPackPrefix(p.name) === bareName,
  )
  if (!match) {
    return { error: `No pack named "${bareName}" in the registry. Configured sources: SAMSINN_PACK_SOURCES env. Use \`user/repo\` or a full URL to install from elsewhere.` }
  }
  return { url: `${match.repoUrl}.git`, sourceLabel: stripPackPrefix(match.name) }
}

// --- Tools ---

export const createInstallPackTool = (deps: PackToolsDeps): Tool => ({
  name: 'install_pack',
  description: 'Installs a pack (tools + skills) from GitHub. Source: bare name (registry), user/repo, or git URL. Tools become `<pack>_<tool>`; skills become `<pack>/<skill>`.',
  usage: 'Bring domain-specific tooling into the session. Effect is immediate. Call list_available_packs first if unsure of names.',
  returns: 'Object with namespace, registered tool names, registered skill names, and the manifest if present.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Bare pack name (resolved via registry), user/repo shorthand, or full git URL' },
      name: { type: 'string', description: 'Override the canonical namespace (optional — defaults to pack.json name or stripped basename)' },
    },
    required: ['source'],
  },
  execute: async (params) => {
    const source = (params.source as string ?? '').trim()
    const override = typeof params.name === 'string' ? (params.name as string).trim() : ''
    if (!source) return { success: false, error: 'source is required' }

    const isBareName =
      !source.includes('/') &&
      !/^(https?:|ssh:|git:|file:)/i.test(source) &&
      !source.includes('@')
    const resolved = isBareName ? await resolveBareName(source) : resolveSource(source)
    if ('error' in resolved) return { success: false, error: resolved.error }

    // Ensure parent exists, then clone into a *temp* dir under packsDir so
    // we can read the manifest BEFORE picking the final destination.
    await $`mkdir -p ${deps.packsDir}`.quiet().nothrow()
    let tempDir: string
    try {
      tempDir = await mkdtemp(join(deps.packsDir, '.tmp-install-'))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { success: false, error: `Could not create temp dir for install: ${reason}` }
    }

    const cleanup = async () => { try { await rm(tempDir, { recursive: true, force: true }) } catch { /* ignore */ } }

    const clone = await $`git clone --depth 1 ${resolved.url} ${tempDir}`.quiet().nothrow()
    if (clone.exitCode !== 0) {
      await cleanup()
      const stderr = clone.stderr.toString().trim()
      return { success: false, error: `git clone failed: ${stderr || 'unknown error'}` }
    }

    // Resolve the canonical namespace from the manifest. Override always
    // wins; otherwise pack.json name; otherwise stripped basename.
    const manifest = await readManifest(tempDir)
    let namespace: string
    if (override) {
      namespace = override
      if (!VALID_NS.test(namespace)) {
        await cleanup()
        return { success: false, error: `Invalid namespace override "${namespace}"` }
      }
    } else {
      const derived = resolveInstallNamespace(manifest, resolved.sourceLabel)
      if (!derived) {
        await cleanup()
        return { success: false, error: `Could not derive a valid namespace from manifest or source basename "${resolved.sourceLabel}". Pass an explicit \`name\`.` }
      }
      namespace = derived
    }

    // Refuse to overwrite an existing install — user must uninstall first.
    const finalPath = join(deps.packsDir, namespace)
    try {
      const s = await stat(finalPath)
      if (s.isDirectory()) {
        await cleanup()
        return { success: false, error: `Pack "${namespace}" is already installed — use update_pack to refresh or uninstall_pack first` }
      }
    } catch { /* not present — proceed */ }

    try {
      await rename(tempDir, finalPath)
    } catch (err) {
      await cleanup()
      const reason = err instanceof Error ? err.message : String(err)
      return { success: false, error: `Could not move installed pack into place: ${reason}` }
    }

    const result = await loadPack(
      { namespace, dirPath: finalPath, manifest },
      deps.toolRegistry,
      deps.skillStore,
    )

    try {
      await deps.refreshAllAgentTools()
    } catch (err) {
      console.error(`[packs] refreshAllAgentTools failed after install "${namespace}":`, err)
    }
    deps.notifyPacksChanged?.({
      action: 'installed', namespace,
      tools: result.tools, skills: result.skills,
    })

    return {
      success: true,
      data: {
        namespace,
        url: resolved.url,
        tools: result.tools,
        skills: result.skills,
        manifest,
        errors: result.errors,
      },
    }
  },
})

export const createUpdatePackTool = (deps: PackToolsDeps): Tool => ({
  name: 'update_pack',
  description: 'Pulls the latest commits for an installed pack and re-registers its tools/skills. Preserves changes git can fast-forward over.',
  returns: 'Object with namespace and refreshed tool/skill counts.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Pack namespace (directory name under ~/.samsinn/packs)' },
    },
    required: ['name'],
  },
  execute: async (params) => {
    const namespace = (params.name as string)?.trim() ?? ''
    if (!VALID_NS.test(namespace)) return { success: false, error: `Invalid pack name "${namespace}"` }

    const dirPath = join(deps.packsDir, namespace)
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) return { success: false, error: `Pack "${namespace}" is not installed` }
    } catch {
      return { success: false, error: `Pack "${namespace}" is not installed` }
    }

    const pull = await $`git -C ${dirPath} pull --ff-only`.quiet().nothrow()
    if (pull.exitCode !== 0) {
      const stderr = pull.stderr.toString().trim()
      return { success: false, error: `git pull failed: ${stderr || 'unknown error'}` }
    }

    // Unregister the pack's current artifacts, then re-load from disk.
    deps.toolRegistry.unregisterByPack(namespace)
    deps.skillStore.removeByPack(namespace)

    const manifest = await readManifest(dirPath)
    const result = await loadPack(
      { namespace, dirPath, manifest },
      deps.toolRegistry,
      deps.skillStore,
    )

    try {
      await deps.refreshAllAgentTools()
    } catch (err) {
      console.error(`[packs] refreshAllAgentTools failed after update "${namespace}":`, err)
    }
    deps.notifyPacksChanged?.({
      action: 'updated', namespace,
      tools: result.tools, skills: result.skills,
    })

    return {
      success: true,
      data: {
        namespace,
        tools: result.tools,
        skills: result.skills,
        manifest,
        stdout: pull.stdout.toString().trim(),
      },
    }
  },
})

export const createUninstallPackTool = (deps: PackToolsDeps): Tool => ({
  name: 'uninstall_pack',
  description: 'Unregisters a pack\'s tools and skills, then deletes its directory under ~/.samsinn/packs.',
  returns: 'Object with namespace and the tool/skill keys that were unregistered.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Pack namespace (directory name under ~/.samsinn/packs)' },
    },
    required: ['name'],
  },
  execute: async (params) => {
    const namespace = (params.name as string)?.trim() ?? ''
    if (!VALID_NS.test(namespace)) return { success: false, error: `Invalid pack name "${namespace}"` }

    const dirPath = join(deps.packsDir, namespace)
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) return { success: false, error: `Pack "${namespace}" is not installed` }
    } catch {
      return { success: false, error: `Pack "${namespace}" is not installed` }
    }

    const removedTools = deps.toolRegistry.unregisterByPack(namespace)
    const removedSkills = deps.skillStore.removeByPack(namespace)

    try {
      await deps.refreshAllAgentTools()
    } catch (err) {
      console.error(`[packs] refreshAllAgentTools failed after uninstall "${namespace}":`, err)
    }
    deps.notifyPacksChanged?.({
      action: 'uninstalled', namespace,
      tools: removedTools, skills: removedSkills,
    })

    const rm = await $`rm -rf ${dirPath}`.quiet().nothrow()
    if (rm.exitCode !== 0) {
      return {
        success: false,
        error: `Unregistered from runtime but failed to delete directory: ${rm.stderr.toString().trim()}`,
      }
    }

    return {
      success: true,
      data: { namespace, removedTools, removedSkills },
    }
  },
})

export const createListPacksTool = (deps: PackToolsDeps): Tool => ({
  name: 'list_packs',
  description: 'Lists all installed packs with their manifest and per-pack tool/skill counts.',
  returns: 'Array of pack objects.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const packs = await scanPacks(deps.packsDir)
    const entries = deps.toolRegistry.listEntries()
    const skills = deps.skillStore.list()

    const data = packs.map(p => {
      const toolKeys = entries
        .filter(e => e.source.kind === 'pack-bundled' && e.source.pack === p.namespace)
        .map(e => e.tool.name)
      const skillKeys = skills
        .filter(s => s.pack === p.namespace)
        .map(s => s.name)
      return {
        namespace: p.namespace,
        dirPath: p.dirPath,
        manifest: p.manifest,
        tools: toolKeys,
        skills: skillKeys,
      }
    })

    return { success: true, data }
  },
})

export const createListAvailablePacksTool = (deps: PackToolsDeps): Tool => ({
  name: 'list_available_packs',
  description: 'Lists installable packs from the configured registry. Each entry has the canonical name for install_pack and an `installed` flag. Call this BEFORE install_pack — do not guess repo names.',
  returns: 'Array of registry entries with name (canonical), repoName, source (owner/repo), repoUrl, description, and installed flag.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    try {
      const available = await getAvailablePacks()
      const installed = new Set((await scanPacks(deps.packsDir)).map(p => p.namespace))
      const data = available.map(p => ({
        name: p.name,
        repoName: p.repoName,
        source: p.source,
        repoUrl: p.repoUrl,
        description: p.description,
        installed: installed.has(p.name),
      }))
      return { success: true, data }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { success: false, error: `registry fetch failed: ${reason}` }
    }
  },
})

export const createPackTools = (deps: PackToolsDeps): ReadonlyArray<Tool> => [
  createInstallPackTool(deps),
  createUpdatePackTool(deps),
  createUninstallPackTool(deps),
  createListPacksTool(deps),
  createListAvailablePacksTool(deps),
]
