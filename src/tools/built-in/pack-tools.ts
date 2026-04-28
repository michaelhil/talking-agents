// ============================================================================
// Pack admin tools — install / update / uninstall / list packs from GitHub.
//
// A pack is a git-cloned directory under ~/.samsinn/packs/<ns>/ with optional
// pack.json plus tools/ and skills/ subdirs. The namespace is the directory
// basename; it prefixes all registered tools (`<ns>_<tool>`) and skills
// (`<ns>/<skill>`) to eliminate cross-pack name collisions.
//
// install_pack accepts:
//   - bare name          → github.com/samsinn-packs/<name>.git  (default org)
//   - "user/repo"        → github.com/user/repo.git
//   - full URL           → cloned as-is (https://, ssh, file://, ...)
//
// All shell-outs go through `Bun.$` tagged-template form so arguments are
// quoted correctly — never string-concatenated.
// ============================================================================

import type { Tool, ToolRegistry } from '../../core/types/tool.ts'
import type { SkillStore } from '../../skills/loader.ts'
import { loadPack } from '../../packs/loader.ts'
import { readManifest } from '../../packs/manifest.ts'
import { scanPacks } from '../../packs/scanner.ts'
import { getAvailablePacks } from '../../packs/registry.ts'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { $ } from 'bun'

const DEFAULT_ORG = 'samsinn-packs'

// Pack namespaces are directory names — same regex as tool/skill names.
const VALID_NS = /^[a-zA-Z0-9_-]+$/

type RefreshAllFn = () => Promise<void>

export interface PackToolsDeps {
  readonly packsDir: string
  readonly toolRegistry: ToolRegistry
  readonly skillStore: SkillStore
  readonly refreshAllAgentTools: RefreshAllFn
}

// --- URL + namespace resolution ---

interface ResolvedSource {
  readonly url: string
  readonly namespace: string  // default — user can override via explicit param
}

// Guess the canonical namespace (directory name) from a git URL or short spec.
// For "user/repo" or bare "name", the repo part is the namespace. For full
// URLs, strip trailing .git and take the last path segment.
const namespaceFromUrl = (url: string): string => {
  // Handle file:// and plain paths too — last segment works universally.
  const withoutGit = url.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const parts = withoutGit.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

const resolveSource = (source: string): ResolvedSource | { error: string } => {
  const s = source.trim()
  if (!s) return { error: 'source is required' }

  // Full URL (anything with a scheme or @ for ssh).
  if (/^(https?:|ssh:|git:|file:)/i.test(s) || s.includes('@')) {
    const ns = namespaceFromUrl(s)
    if (!VALID_NS.test(ns)) return { error: `Cannot derive namespace from URL "${s}" — use explicit name param` }
    return { url: s, namespace: ns }
  }

  // user/repo shorthand.
  if (s.includes('/')) {
    const parts = s.split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { error: `Invalid shorthand "${s}" — expected "user/repo"` }
    }
    if (!VALID_NS.test(parts[1])) return { error: `Invalid repo name "${parts[1]}"` }
    return { url: `https://github.com/${parts[0]}/${parts[1]}.git`, namespace: parts[1] }
  }

  // Bare name → default org.
  if (!VALID_NS.test(s)) return { error: `Invalid pack name "${s}" — use letters, digits, underscores, hyphens` }
  return { url: `https://github.com/${DEFAULT_ORG}/${s}.git`, namespace: s }
}

// --- Tools ---

// Match a bare-name install request against the configured registry.
// Returns the registry entry (which carries the canonical source URL) when
// the bare name matches a registry pack's full repo name OR its name with
// the `samsinn-pack-` prefix stripped (so `install_pack vatsim` finds
// `michaelhil/samsinn-pack-vatsim`). Used as a smart-default — explicit
// `user/repo` and full URL forms still bypass this.
const stripPackPrefix = (s: string): string => s.replace(/^samsinn-pack-/, '')

const resolveFromRegistry = async (bareName: string): Promise<ResolvedSource | null> => {
  try {
    const available = await getAvailablePacks()
    const match = available.find(
      p => p.name === bareName || stripPackPrefix(p.name) === bareName,
    )
    if (!match) return null
    return {
      url: `${match.repoUrl}.git`,
      namespace: stripPackPrefix(match.name),
    }
  } catch {
    return null
  }
}

export const createInstallPackTool = (deps: PackToolsDeps): Tool => ({
  name: 'install_pack',
  description: 'Installs a pack (bundle of tools + skills) from GitHub. The agent-friendly form is a bare name (e.g. `vatsim`) — that resolves against the configured pack registry first (call list_available_packs to see what is publishable). Falls back to github.com/samsinn-packs/<name> when no registry match is found. Also accepts "user/repo" shorthand or a full git URL. Tools are namespaced as `<pack>_<tool>` and skills as `<pack>/<skill>`.',
  usage: 'Use to bring domain-specific tooling (e.g. air-traffic-control, driving) into the current session. Effect is immediate — no restart needed. If unsure what is available, call list_available_packs first.',
  returns: 'Object with namespace, registered tool names, registered skill names, and the manifest if present.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Pack name (resolved via registry), user/repo shorthand, or full git URL' },
      name: { type: 'string', description: 'Override the default namespace (optional — defaults to registry-stripped name or repo basename)' },
    },
    required: ['source'],
  },
  execute: async (params) => {
    const source = params.source as string
    const override = typeof params.name === 'string' ? (params.name as string).trim() : ''

    // Bare-name path: try the registry first. This is what makes
    // `install_pack vatsim` find `michaelhil/samsinn-pack-vatsim` without
    // the agent needing to know the exact repo path.
    const isBareName = !source.includes('/') && !/^(https?:|ssh:|git:|file:)/i.test(source) && !source.includes('@')
    let resolved: ResolvedSource | { error: string } | null = null
    if (isBareName) {
      resolved = await resolveFromRegistry(source.trim())
    }
    if (!resolved) resolved = resolveSource(source)
    if ('error' in resolved) return { success: false, error: resolved.error }

    const namespace = override || resolved.namespace
    if (!VALID_NS.test(namespace)) {
      return { success: false, error: `Invalid namespace "${namespace}"` }
    }

    const dirPath = join(deps.packsDir, namespace)

    // Refuse to overwrite an existing install — user must uninstall first.
    try {
      const s = await stat(dirPath)
      if (s.isDirectory()) {
        return { success: false, error: `Pack "${namespace}" is already installed — use update_pack to refresh or uninstall_pack first` }
      }
    } catch { /* not present — proceed */ }

    // Ensure parent exists.
    await $`mkdir -p ${deps.packsDir}`.quiet().nothrow()

    // Clone. Bun.$ quotes arguments; shell injection via source/namespace
    // is not possible here.
    const clone = await $`git clone --depth 1 ${resolved.url} ${dirPath}`.quiet().nothrow()
    if (clone.exitCode !== 0) {
      // Best-effort cleanup — a failed clone may still leave a partial dir.
      await $`rm -rf ${dirPath}`.quiet().nothrow()
      const stderr = clone.stderr.toString().trim()
      return { success: false, error: `git clone failed: ${stderr || 'unknown error'}` }
    }

    const manifest = await readManifest(dirPath)
    const result = await loadPack(
      { namespace, dirPath, manifest },
      deps.toolRegistry,
      deps.skillStore,
    )

    try {
      await deps.refreshAllAgentTools()
    } catch (err) {
      console.error(`[packs] refreshAllAgentTools failed after install "${namespace}":`, err)
    }

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
  description: 'Pulls the latest commits for an installed pack, then re-registers its tools and skills. Equivalent to uninstall + install but preserves local changes that git can fast-forward over.',
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
  description: 'Lists packs that can be installed via `install_pack`, sourced from the configured registry (SAMSINN_PACK_SOURCES). Each entry includes the bare name to pass to install_pack and whether it is already installed. Call this BEFORE install_pack when the user asks for an unknown domain — do not guess repo names.',
  returns: 'Array of registry entries with name, source (owner/repo), repoUrl, description, and installed flag.',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    try {
      const available = await getAvailablePacks()
      const installed = new Set((await scanPacks(deps.packsDir)).map(p => p.namespace))
      const data = available.map(p => ({
        bareName: stripPackPrefix(p.name),
        repoName: p.name,
        source: p.source,
        repoUrl: p.repoUrl,
        description: p.description,
        installed: installed.has(p.name) || installed.has(stripPackPrefix(p.name)),
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
