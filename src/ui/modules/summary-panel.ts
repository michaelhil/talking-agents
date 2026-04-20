// ============================================================================
// Summary & Compression panel — settings + inspect modals.
// Controlled via WS (set_summary_config, regenerate_summary) and a REST GET
// for the current summary/compression snapshot. Streaming deltas arrive
// through the WS dispatcher and are forwarded to this panel while open.
// ============================================================================

import type { SummaryConfig, Aggressiveness } from '../../core/types/summary.ts'
import type { WSClient } from './ws-client.ts'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

// --- Per-room expand state for the header group ---
const groupExpanded = new Map<string, boolean>()

export const isSummaryGroupExpanded = (roomId: string): boolean =>
  groupExpanded.get(roomId) ?? false

export const toggleSummaryGroup = (roomId: string): boolean => {
  const next = !(groupExpanded.get(roomId) ?? false)
  groupExpanded.set(roomId, next)
  return next
}

// --- Settings modal ---

export const openSummarySettingsModal = (
  roomName: string,
  currentConfig: SummaryConfig,
  ws: WSClient,
): void => {
  const modal = $<HTMLDialogElement>('summary-settings-modal')
  $<HTMLElement>('summary-settings-roomname').textContent = roomName
  $<HTMLInputElement>('summary-cfg-model').value = currentConfig.model ?? ''

  const sumEnabled = $<HTMLInputElement>('summary-cfg-summary-enabled')
  const sumByMsg = $<HTMLInputElement>('summary-cfg-summary-by-msg')
  const sumByTime = $<HTMLInputElement>('summary-cfg-summary-by-time')
  const sumMsgCount = $<HTMLInputElement>('summary-cfg-summary-msg-count')
  const sumSecCount = $<HTMLInputElement>('summary-cfg-summary-sec-count')

  const compEnabled = $<HTMLInputElement>('summary-cfg-comp-enabled')
  const compByMsg = $<HTMLInputElement>('summary-cfg-comp-by-msg')
  const compByTime = $<HTMLInputElement>('summary-cfg-comp-by-time')
  const compMsgCount = $<HTMLInputElement>('summary-cfg-comp-msg-count')
  const compSecCount = $<HTMLInputElement>('summary-cfg-comp-sec-count')
  const keepFresh = $<HTMLInputElement>('summary-cfg-keep-fresh')
  const batchSize = $<HTMLInputElement>('summary-cfg-batch-size')
  const agg = $<HTMLSelectElement>('summary-cfg-aggressiveness')

  // Populate from current config
  sumEnabled.checked = currentConfig.summary.enabled
  if (currentConfig.summary.schedule.kind === 'time') {
    sumByTime.checked = true; sumByMsg.checked = false
    sumSecCount.value = String(currentConfig.summary.schedule.everySeconds)
  } else {
    sumByMsg.checked = true; sumByTime.checked = false
    sumMsgCount.value = String(currentConfig.summary.schedule.everyMessages)
  }

  compEnabled.checked = currentConfig.compression.enabled
  if (currentConfig.compression.schedule.kind === 'time') {
    compByTime.checked = true; compByMsg.checked = false
    compSecCount.value = String(currentConfig.compression.schedule.everySeconds)
  } else {
    compByMsg.checked = true; compByTime.checked = false
    compMsgCount.value = String(currentConfig.compression.schedule.everyMessages)
  }
  keepFresh.value = String(currentConfig.compression.keepFresh)
  batchSize.value = String(currentConfig.compression.batchSize)
  agg.value = currentConfig.compression.aggressiveness

  const form = $<HTMLFormElement>('summary-settings-form')
  const submitHandler = (e: Event) => {
    e.preventDefault()
    const modelVal = $<HTMLInputElement>('summary-cfg-model').value.trim()
    const config: SummaryConfig = {
      ...(modelVal ? { model: modelVal } : {}),
      summary: {
        enabled: sumEnabled.checked,
        schedule: sumByTime.checked
          ? { kind: 'time', everySeconds: Math.max(5, parseInt(sumSecCount.value, 10) || 300) }
          : { kind: 'messages', everyMessages: Math.max(1, parseInt(sumMsgCount.value, 10) || 25) },
      },
      compression: {
        enabled: compEnabled.checked,
        schedule: compByTime.checked
          ? { kind: 'time', everySeconds: Math.max(5, parseInt(compSecCount.value, 10) || 300) }
          : { kind: 'messages', everyMessages: Math.max(1, parseInt(compMsgCount.value, 10) || 30) },
        keepFresh: Math.max(1, parseInt(keepFresh.value, 10) || 40),
        batchSize: Math.max(1, parseInt(batchSize.value, 10) || 30),
        aggressiveness: agg.value as Aggressiveness,
      },
    }
    ws.send({ type: 'set_summary_config', roomName, config })
    modal.close()
  }
  // Re-bind: clear any prior listener
  form.onsubmit = submitHandler
  $<HTMLButtonElement>('summary-cfg-cancel').onclick = () => modal.close()

  modal.showModal()
}

// --- Inspect modal ---

interface InspectState {
  roomName: string
  summaryText: string
  compressionText: string
  summaryRunning: boolean
  compressionRunning: boolean
}

const inspectState: InspectState = {
  roomName: '',
  summaryText: '',
  compressionText: '',
  summaryRunning: false,
  compressionRunning: false,
}

const renderInspect = (): void => {
  $<HTMLElement>('summary-inspect-summary-text').textContent = inspectState.summaryText || (inspectState.summaryRunning ? '' : '(no summary yet)')
  $<HTMLElement>('summary-inspect-compression-text').textContent = inspectState.compressionText || (inspectState.compressionRunning ? '' : '(no compression yet)')
  $<HTMLElement>('summary-inspect-summary-status').textContent = inspectState.summaryRunning ? '· processing…' : ''
  $<HTMLElement>('summary-inspect-compression-status').textContent = inspectState.compressionRunning ? '· processing…' : ''
}

const isInspectOpenFor = (roomName: string): boolean => {
  const modal = document.getElementById('summary-inspect-modal') as HTMLDialogElement | null
  return !!modal?.open && inspectState.roomName === roomName
}

export const openSummaryInspectModal = async (
  roomName: string,
  ws: WSClient,
): Promise<void> => {
  const modal = $<HTMLDialogElement>('summary-inspect-modal')
  $<HTMLElement>('summary-inspect-roomname').textContent = roomName
  inspectState.roomName = roomName
  inspectState.summaryText = ''
  inspectState.compressionText = ''
  inspectState.summaryRunning = false
  inspectState.compressionRunning = false
  renderInspect()

  // Fetch current state
  try {
    const resp = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/summary`)
    if (resp.ok) {
      const data = await resp.json() as { summary: string | null; compression: { content: string } | null }
      inspectState.summaryText = data.summary ?? ''
      inspectState.compressionText = data.compression?.content ?? ''
    }
  } catch { /* no-op, leave empty */ }

  // If neither exists, auto-trigger generation of both
  const needSummary = !inspectState.summaryText
  const needCompression = !inspectState.compressionText
  if (needSummary && needCompression) {
    inspectState.summaryRunning = true
    inspectState.compressionRunning = true
    ws.send({ type: 'regenerate_summary', roomName, target: 'both' })
  } else if (needSummary) {
    inspectState.summaryRunning = true
    ws.send({ type: 'regenerate_summary', roomName, target: 'summary' })
  } else if (needCompression) {
    inspectState.compressionRunning = true
    ws.send({ type: 'regenerate_summary', roomName, target: 'compression' })
  }
  renderInspect()

  $<HTMLButtonElement>('summary-inspect-close').onclick = () => modal.close()
  $<HTMLButtonElement>('summary-inspect-regen-summary').onclick = () => {
    inspectState.summaryText = ''
    inspectState.summaryRunning = true
    renderInspect()
    ws.send({ type: 'regenerate_summary', roomName, target: 'summary' })
  }
  $<HTMLButtonElement>('summary-inspect-regen-compression').onclick = () => {
    inspectState.compressionText = ''
    inspectState.compressionRunning = true
    renderInspect()
    ws.send({ type: 'regenerate_summary', roomName, target: 'compression' })
  }
  $<HTMLButtonElement>('summary-inspect-regen-both').onclick = () => {
    inspectState.summaryText = ''
    inspectState.compressionText = ''
    inspectState.summaryRunning = true
    inspectState.compressionRunning = true
    renderInspect()
    ws.send({ type: 'regenerate_summary', roomName, target: 'both' })
  }

  modal.showModal()
}

// Handlers called by ws-dispatch on summary_run_* events.
export const handleSummaryRunStarted = (roomName: string, target: 'summary' | 'compression'): void => {
  if (!isInspectOpenFor(roomName)) return
  if (target === 'summary') { inspectState.summaryRunning = true; inspectState.summaryText = '' }
  else { inspectState.compressionRunning = true; inspectState.compressionText = '' }
  renderInspect()
}

export const handleSummaryRunDelta = (roomName: string, target: 'summary' | 'compression', delta: string): void => {
  if (!isInspectOpenFor(roomName)) return
  if (target === 'summary') inspectState.summaryText += delta
  else inspectState.compressionText += delta
  renderInspect()
}

export const handleSummaryRunCompleted = (roomName: string, target: 'summary' | 'compression', text: string): void => {
  if (!isInspectOpenFor(roomName)) return
  if (target === 'summary') { inspectState.summaryRunning = false; inspectState.summaryText = text || inspectState.summaryText }
  else { inspectState.compressionRunning = false; inspectState.compressionText = text || inspectState.compressionText }
  renderInspect()
}

export const handleSummaryRunFailed = (roomName: string, target: 'summary' | 'compression', reason: string): void => {
  if (!isInspectOpenFor(roomName)) return
  if (target === 'summary') { inspectState.summaryRunning = false; inspectState.summaryText = `[error] ${reason}` }
  else { inspectState.compressionRunning = false; inspectState.compressionText = `[error] ${reason}` }
  renderInspect()
}
