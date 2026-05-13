// Long-running progress events: scripts, summary runs, ollama health,
// provider routing toasts. These don't mutate persistent state — they
// surface progress / interventions to the user.

import {
  $agents,
  $scriptCatalog,
  $activeScriptByRoom,
  $ollamaHealth,
  $lastProviderEvent,
  $pendingModelChanges,
} from '../../stores.ts'
import type { WSOutbound } from '../../../../core/types/ws-protocol.ts'
import { showToast } from '../../toast.ts'
import { roomNameToId } from '../../identity-lookups.ts'
import {
  handleSummaryRunStarted,
  handleSummaryRunDelta,
  handleSummaryRunCompleted,
  handleSummaryRunFailed,
} from '../../panels/summary-panel.ts'
import { shouldEmitBound } from '../dedup.ts'

type OutboundByType<K extends WSOutbound['type']> = Extract<WSOutbound, { readonly type: K }>

type RunHandlers = {
  readonly [K in WSOutbound['type']]?: (msg: OutboundByType<K>) => void
}

export const runHandlers: RunHandlers = {

  // --- Scripts ---

  script_started(msg) {
    const roomId = roomNameToId(msg.roomName)
    if (!roomId) return
    // Seed $agents with the cast — script-runner spawns them server-side
    // but doesn't fire the per-agent agent_joined event, so the UI's
    // agents store needs to learn about them here.
    for (const c of msg.cast) {
      $agents.setKey(c.id, { id: c.id, name: c.name, kind: c.kind, model: c.model, state: 'idle' })
    }
    $activeScriptByRoom.setKey(roomId, {
      scriptId: msg.scriptId,
      scriptName: msg.scriptName,
      title: msg.title,
      ...(msg.premise ? { premise: msg.premise } : {}),
      stepIndex: 0,
      totalSteps: msg.totalSteps,
      stepTitle: msg.stepTitle,
      readiness: {},
      readyStreak: {},
      whisperFailures: 0,
      lastWhisper: {},
      stepLogs: {},
      cast: msg.cast.map(c => ({ id: c.id, name: c.name, model: c.model, persona: c.persona, starts: c.starts })),
      steps: msg.steps.map(s => ({ title: s.title, ...(s.goal ? { goal: s.goal } : {}), roles: s.roles })),
      ended: false,
    })
  },

  script_step_advanced(msg) {
    const roomId = roomNameToId(msg.roomName)
    if (!roomId) return
    const cur = $activeScriptByRoom.get()[roomId]
    if (!cur) return
    $activeScriptByRoom.setKey(roomId, {
      ...cur,
      stepIndex: msg.stepIndex,
      totalSteps: msg.totalSteps,
      stepTitle: msg.title,
      readiness: {},                              // resets on advance
      readyStreak: {},                            // resets on advance
      lastWhisper: {},                            // resets on advance
    })
  },

  script_readiness_changed(msg) {
    const roomId = roomNameToId(msg.roomName)
    if (!roomId) return
    const cur = $activeScriptByRoom.get()[roomId]
    if (!cur) return
    $activeScriptByRoom.setKey(roomId, {
      ...cur,
      readiness: msg.readiness,
      readyStreak: msg.readyStreak,
      whisperFailures: msg.whisperFailures,
      lastWhisper: msg.lastWhisper,
    })
  },

  script_dialogue_appended(msg) {
    const roomId = roomNameToId(msg.roomName)
    if (!roomId) return
    const cur = $activeScriptByRoom.get()[roomId]
    if (!cur) return
    const prev = cur.stepLogs[msg.stepIndex] ?? []
    // De-dup by messageId in case the WS fires twice (resilience).
    if (prev.some(e => e.messageId === msg.entry.messageId)) return
    const nextStepLogs = { ...cur.stepLogs, [msg.stepIndex]: [...prev, msg.entry] }
    $activeScriptByRoom.setKey(roomId, { ...cur, stepLogs: nextStepLogs })
  },

  script_completed(msg) {
    const roomId = roomNameToId(msg.roomName)
    if (!roomId) return
    const cur = $activeScriptByRoom.get()[roomId]
    if (!cur) return
    // Keep the entry around (with ended:true) so the panel and per-message
    // whisper badges can still render the historical state. Cleared only
    // when a NEW script starts in the same room.
    $activeScriptByRoom.setKey(roomId, { ...cur, ended: true })
  },

  script_catalog_changed(_msg) {
    // Lazy-refetch catalog so any open consumers see the new state.
    void fetch('/api/scripts')
      .then(r => r.ok ? r.json() : { scripts: [] })
      .then(data => {
        const scripts = (data as { scripts?: unknown }).scripts
        if (Array.isArray(scripts)) $scriptCatalog.set(scripts as never)
      })
      .catch(() => { /* ignore */ })
  },

  // --- Ollama ---

  ollama_health(msg) {
    $ollamaHealth.set(msg.health)
  },

  // --- Provider routing ---

  provider_bound(msg) {
    const now = Date.now()
    $lastProviderEvent.set({ ...msg, at: now })

    // Pending user-initiated model change: if this agent has one and the
    // model matches, clear it (verified successfully).
    if (msg.agentId) {
      const pending = $pendingModelChanges.get()[msg.agentId]
      if (pending && pending.model === msg.model) {
        const { [msg.agentId]: _removed, ...rest } = $pendingModelChanges.get()
        $pendingModelChanges.set(rest)
      }
    }

    // Suppress first-ever bindings (oldProvider === null) unless the agent
    // has a pending change — the initial bind is noise; the verified change
    // is the meaningful signal.
    const isPendingVerification = msg.agentId
      ? $pendingModelChanges.get()[msg.agentId] !== undefined
      : false
    if (msg.oldProvider === null && !isPendingVerification) return

    // Dedup: same (agentId, newProvider) within 5s only fires once.
    if (!shouldEmitBound(msg.agentId, msg.newProvider, now)) return

    const who = msg.agentName ? `${msg.agentName}: ` : ''
    const label = `${msg.newProvider}:${msg.model}`
    showToast(document.body, `${who}now using ${label}`, { type: 'success', position: 'fixed' })
  },

  provider_stream_failed(msg) {
    const now = Date.now()
    $lastProviderEvent.set({ ...msg, at: now })
    const who = msg.agentName ? `${msg.agentName}: ` : ''
    showToast(document.body, `${who}stream interrupted on ${msg.provider} (response may be partial)`, { type: 'error', position: 'fixed' })
  },

  // --- Summary + compression ---

  summary_run_started(msg) {
    handleSummaryRunStarted(msg.roomName, msg.target)
  },

  summary_run_delta(msg) {
    handleSummaryRunDelta(msg.roomName, msg.target, msg.delta)
  },

  summary_run_completed(msg) {
    handleSummaryRunCompleted(msg.roomName, msg.target, msg.text)
  },

  summary_run_failed(msg) {
    handleSummaryRunFailed(msg.roomName, msg.target, msg.reason)
    showToast(document.body, `Summary (${msg.target}) failed: ${msg.reason}`, { type: 'error', position: 'fixed' })
  },
}
