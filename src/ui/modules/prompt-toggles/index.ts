// ============================================================================
// Context panel — per-agent controls for what the LLM receives.
//
// Layout (no fold-outs except per-tool list):
//   Summary strip   — one-line totals + overflow warning
//   2x2 grid:
//     Prompts ☑ | Context ☑
//     Tools   ☑ | Model
//
// Three groups (Prompts / Context / Tools) each have a master checkbox: when
// off, the group's children are visually greyed and disabled, individual state
// is preserved on the server. Tools keeps a fold-out for its 60-item per-tool
// list (the only remaining fold on the panel).
//
// This file is the orchestrator: it owns the panel root, summary bar, fold
// state, and the render loop. Group builders live in ./groups.ts.
// ============================================================================

import { safeFetchJson } from '../ui-utils.ts'
import { $selectedRoomId } from '../stores.ts'
import { buildPromptsGroup } from './prompts-group.ts'
import { buildContextGroup } from './context-group.ts'
import { buildToolsGroup } from './tools-group.ts'
import { buildModelGroup } from './model-group.ts'
import {
  sectionByKey,
  PROMPT_KEYS,
  CONTEXT_KEYS,
  type AgentData,
  type ContextPreview,
  type GroupDeps,
} from './shared.ts'

export interface PromptTogglesDeps {
  readonly agentName: string
  readonly agentEnc: string
  readonly agentData: AgentData & Record<string, unknown>
  readonly promptTextarea: HTMLTextAreaElement
}

export const renderPromptToggles = (container: HTMLElement, deps: PromptTogglesDeps): void => {
  const { agentEnc, agentData, promptTextarea } = deps

  // Per-tool fold state persists across re-renders within this inspector
  // session, so per-tool checkbox edits don't collapse the list.
  const toolsFoldOpen = { current: false }

  const panel = document.createElement('div')
  panel.className = 'border border-border rounded mb-3 px-3 py-2'
  container.appendChild(panel)

  const summaryBar = document.createElement('div')
  summaryBar.className = 'text-xs font-semibold text-text-subtle uppercase tracking-wide mb-2'
  summaryBar.textContent = 'Context — loading…'
  panel.appendChild(summaryBar)

  const body = document.createElement('div')
  panel.appendChild(body)

  const getRoomIdForPreview = (): string | undefined => {
    const sel = $selectedRoomId.get()
    const joined = agentData.rooms as string[] | undefined
    if (sel && joined?.includes(sel)) return sel
    return joined?.[0]
  }

  const fetchPreview = async (): Promise<ContextPreview | null> => {
    const roomId = getRoomIdForPreview()
    const qs = roomId ? `?roomId=${encodeURIComponent(roomId)}` : ''
    return safeFetchJson<ContextPreview>(`/api/agents/${agentEnc}/context-preview${qs}`)
  }

  const patchAgent = async (patch: Record<string, unknown>): Promise<void> => {
    await safeFetchJson(`/api/agents/${agentEnc}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }

  const updateSummary = (preview: ContextPreview): void => {
    const get = (k: string) => sectionByKey(preview, k)
    const includePrompts = (agentData.includePrompts as Record<string, boolean>) ?? {}
    const includeContext = (agentData.includeContext as Record<string, boolean>) ?? {}
    const includeTools = (agentData.includeTools as boolean) ?? true
    const promptsEnabled = (agentData.promptsEnabled as boolean) ?? true
    const contextEnabled = (agentData.contextEnabled as boolean) ?? true
    const enabledTools = new Set<string>(
      (agentData.tools as string[] | undefined) ?? preview.registeredTools,
    )

    const promptsOn = promptsEnabled
      ? PROMPT_KEYS.filter(p => (includePrompts[p.code] ?? true) && (get(p.section)?.enabled ?? false)).length
      : 0
    const promptsTotal = PROMPT_KEYS.filter(p => (get(p.section)?.text?.length ?? 0) > 0).length
    const ctxOn = contextEnabled
      ? CONTEXT_KEYS.filter(c => (includeContext[c.code] ?? true) && (get(c.section)?.enabled ?? false)).length
      : 0
    const ctxTotal = CONTEXT_KEYS.filter(c => (get(c.section)?.text?.length ?? 0) > 0).length

    let used = 0
    if (promptsEnabled) for (const p of PROMPT_KEYS) {
      if ((includePrompts[p.code] ?? true)) used += get(p.section)?.tokens ?? 0
    }
    if (contextEnabled) for (const c of CONTEXT_KEYS) {
      if ((includeContext[c.code] ?? true)) used += get(c.section)?.tokens ?? 0
    }
    if (includeTools) for (const t of enabledTools) used += preview.toolTokens[t] ?? 0

    const modelMax = preview.modelMax
    const pct = modelMax > 0 ? (used / modelMax) * 100 : 0
    const overflow = modelMax > 0 && pct >= 90
    const tokenStr = modelMax > 0
      ? `~${used.toLocaleString()} / ${modelMax.toLocaleString()} tok (${pct.toFixed(1)}%)`
      : `~${used.toLocaleString()} tok (model window unknown)`
    summaryBar.textContent = `${tokenStr} · ${promptsOn}/${promptsTotal} prompts · ${ctxOn}/${ctxTotal} context · ${includeTools ? enabledTools.size : 0}/${preview.registeredTools.length} tools ${overflow ? '⚠' : ''}`
    summaryBar.style.color = overflow ? '#d97706' : ''
  }

  const render = async (): Promise<void> => {
    const joinedRooms = (agentData.rooms as string[] | undefined) ?? []
    if (joinedRooms.length === 0) {
      body.innerHTML = ''
      summaryBar.textContent = 'Context — (no room)'
      body.textContent = 'Add this agent to a room to see its context.'
      return
    }
    const preview = await fetchPreview()
    body.innerHTML = ''
    if (!preview) {
      summaryBar.textContent = 'Context — (failed to load)'
      body.textContent = 'Failed to load context preview.'
      return
    }

    const grid = document.createElement('div')
    grid.className = 'grid grid-cols-2 gap-x-6 gap-y-4 text-xs'
    body.appendChild(grid)

    const deps: GroupDeps = { preview, agentData, promptTextarea, patchAgent, rerender: render }

    grid.appendChild(buildPromptsGroup(deps))
    grid.appendChild(buildContextGroup(deps))
    grid.appendChild(buildToolsGroup({ ...deps, foldOpen: toolsFoldOpen }))
    grid.appendChild(buildModelGroup(deps))

    updateSummary(preview)
  }

  void render()
}
