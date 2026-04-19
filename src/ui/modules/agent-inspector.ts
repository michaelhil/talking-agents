// ============================================================================
// Agent Inspector — Inline view for agent config + memory.
//
// Renders into a container element (center area), not a modal.
// Supports both AI agents (full config + memory) and human agents
// (description only).
// ============================================================================

import { safeFetchJson, showToast, agentNameToId, populateModelSelect } from './ui-utils.ts'
import { $pendingModelChanges } from './stores.ts'
import { renderPromptToggles } from './prompt-toggles.ts'

interface MemoryStats {
  rooms: Array<{ roomId: string; roomName: string; messageCount: number; lastActiveAt?: number }>
  incomingCount: number
  knownAgents: string[]
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const formatTimeAgo = (timestamp: number): string => {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

const renderMemoryMessage = (
  msg: { id: string; senderName?: string; content: string; timestamp: number },
  agentEnc: string,
  roomId: string,
): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'px-3 py-1.5 text-xs border-b border-gray-50 flex items-start gap-2 group hover:bg-gray-50'

  const text = document.createElement('div')
  text.className = 'flex-1 min-w-0'
  const sender = msg.senderName ?? 'unknown'
  const preview = msg.content.length > 120 ? msg.content.slice(0, 120) + '…' : msg.content
  text.innerHTML = `<span class="font-medium text-gray-600">[${escapeHtml(sender)}]</span> <span class="text-gray-500">${escapeHtml(preview)}</span>`
  row.appendChild(text)

  const delBtn = document.createElement('button')
  delBtn.className = 'text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 flex-shrink-0 text-xs'
  delBtn.textContent = '×'
  delBtn.title = 'Delete from agent memory'
  delBtn.onclick = async (e) => {
    e.stopPropagation()
    await safeFetchJson(`/api/agents/${agentEnc}/memory/${encodeURIComponent(roomId)}/${encodeURIComponent(msg.id)}`, { method: 'DELETE' })
    row.remove()
  }
  row.appendChild(delBtn)

  return row
}

// --- Editable field with Update button + toast ---
const createEditableField = (
  label: string,
  value: string,
  onSave: (newValue: string) => Promise<void>,
): { container: HTMLElement; textarea: HTMLTextAreaElement } => {
  const row = document.createElement('div')
  row.className = 'flex items-center justify-between mb-1'
  const labelEl = document.createElement('span')
  labelEl.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide'
  labelEl.textContent = label
  row.appendChild(labelEl)

  const saveBtn = document.createElement('button')
  saveBtn.className = 'text-xs px-3 py-1 bg-gray-300 text-white rounded cursor-not-allowed'
  saveBtn.textContent = 'Update'

  const textarea = document.createElement('textarea')
  textarea.className = 'w-full border rounded p-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-300 mb-3'
  textarea.style.height = '5rem'
  textarea.value = value
  let savedValue = value

  const updateStyle = () => {
    const dirty = textarea.value !== savedValue
    saveBtn.className = dirty
      ? 'text-xs px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 cursor-pointer'
      : 'text-xs px-3 py-1 bg-gray-300 text-white rounded cursor-not-allowed'
  }
  textarea.oninput = updateStyle

  saveBtn.onclick = async () => {
    if (textarea.value === savedValue) return
    await onSave(textarea.value)
    savedValue = textarea.value
    updateStyle()
    row.style.position = 'relative'
    showToast(row, `${label} updated`)
  }

  row.appendChild(saveBtn)

  const container = document.createElement('div')
  container.appendChild(row)
  container.appendChild(textarea)
  return { container, textarea }
}

// --- Main render function ---

export const renderAgentInspector = (container: HTMLElement, agentName: string): void => {
  const enc = encodeURIComponent(agentName)
  container.innerHTML = '<div class="text-sm text-gray-400">Loading…</div>'

  const render = async (): Promise<void> => {
    const agentRes = await safeFetchJson<Record<string, unknown>>(`/api/agents/${enc}`)
    if (!agentRes) {
      container.innerHTML = '<div class="text-sm text-red-500">Failed to load agent data</div>'
      return
    }
    container.innerHTML = ''

    const isAI = agentRes.kind === 'ai'

    // Header: dot + name + model/config (AI) or just name (human)
    const header = document.createElement('div')
    header.className = 'flex items-center gap-1 mb-3'

    const dot = document.createElement('span')
    const isGenerating = agentRes.state === 'generating'
    dot.className = `inline-block w-2.5 h-2.5 rounded-full shrink-0 ${isGenerating ? 'bg-yellow-400 typing-indicator' : 'bg-green-400'}`
    header.appendChild(dot)

    const nameEl = document.createElement('span')
    nameEl.className = 'text-lg font-semibold'
    nameEl.textContent = agentName
    header.appendChild(nameEl)

    if (isAI) {
      // Model selector
      const modelSelect = document.createElement('select')
      modelSelect.className = 'text-sm text-gray-500 font-normal ml-2 border-none bg-transparent cursor-pointer hover:text-blue-500 focus:outline-none'

      // Load models via the structured catalog; pre-select the agent's
      // current model (shown as "(not available)" if the provider is gone).
      const currentModel = (agentRes.model as string) ?? 'n/a'
      modelSelect.innerHTML = `<option value="${currentModel}">${currentModel}</option>`
      void populateModelSelect(modelSelect, { preferredModel: currentModel })
      modelSelect.onchange = async () => {
        if (!modelSelect.value) return
        const newModel = modelSelect.value
        await safeFetchJson(`/api/agents/${enc}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: newModel }),
        })

        // Deferred-verification UX: show pending indicator, clear on matching
        // provider_bound/all_failed event, or after 30s neutral timeout.
        const agentId = agentNameToId(agentName)
        if (!agentId) {
          showToast(document.body, `${agentName} now using ${newModel}`, { position: 'fixed' })
          return
        }
        const savedAt = Date.now()
        $pendingModelChanges.setKey(agentId, { model: newModel, at: savedAt })
        showToast(document.body, `${agentName} → ${newModel}: saved — verifying on next turn…`, { position: 'fixed' })

        // Neutral timeout: 30s after save, if still pending, show neutral
        // toast and close the pending state (so later events are handled as
        // ordinary transitions — see Phase 3 A1 resolution).
        setTimeout(() => {
          const current = $pendingModelChanges.get()[agentId]
          if (current && current.at === savedAt) {
            const { [agentId]: _removed, ...rest } = $pendingModelChanges.get()
            $pendingModelChanges.set(rest)
            showToast(document.body, `${agentName} → ${newModel}: saved — will verify when agent runs next.`, { position: 'fixed' })
          }
        }, 30_000)

      }
      header.appendChild(modelSelect)

      // Config: temp, history, tools
      const temp = agentRes.temperature ?? 'default'
      const histLimit = agentRes.historyLimit ?? 'default'
      const toolsList = agentRes.tools as string[] | undefined
      const toolCount = toolsList?.length ?? 0

      const configSpan = document.createElement('span')
      configSpan.className = 'text-xs text-gray-400 font-normal ml-2 whitespace-nowrap'

      const makeEditable = (label: string, value: string, tooltip: string, field: string): HTMLElement => {
        const wrapper = document.createElement('span')
        wrapper.title = `${tooltip} (click to edit)`
        wrapper.className = 'cursor-pointer hover:text-blue-500'
        const labelSpan = document.createElement('span')
        labelSpan.textContent = `${label}:`
        const valueSpan = document.createElement('span')
        valueSpan.textContent = value
        const resetSpan = document.createElement('span')
        resetSpan.textContent = '↺'
        resetSpan.className = 'text-gray-300 hover:text-red-400 ml-0.5'
        resetSpan.title = 'Reset to default'
        resetSpan.style.display = value === 'default' ? 'none' : 'inline'
        wrapper.appendChild(labelSpan)
        wrapper.appendChild(valueSpan)
        wrapper.appendChild(resetSpan)

        let currentValue = value
        const applyValue = async (newVal: string): Promise<void> => {
          const patchBody: Record<string, unknown> = {}
          patchBody[field] = newVal ? Number(newVal) : undefined
          await safeFetchJson(`/api/agents/${enc}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patchBody),
          })
          currentValue = newVal || 'default'
          valueSpan.textContent = currentValue
          resetSpan.style.display = currentValue === 'default' ? 'none' : 'inline'
        }

        resetSpan.onclick = (e) => { e.stopPropagation(); void applyValue('') }

        wrapper.onclick = (e) => {
          if (e.target === resetSpan) return
          e.stopPropagation()
          const input = document.createElement('input')
          input.type = 'number'
          input.className = 'w-12 text-xs border rounded px-1 py-0 text-gray-600'
          input.value = currentValue === 'default' ? '' : currentValue
          input.step = field === 'temperature' ? '0.1' : '1'
          input.placeholder = 'default'
          valueSpan.replaceWith(input)
          input.focus()
          const save = () => { void applyValue(input.value.trim()); input.replaceWith(valueSpan) }
          input.onblur = save
          input.onkeydown = (ev) => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') input.replaceWith(valueSpan) }
        }
        return wrapper
      }

      configSpan.appendChild(makeEditable('temp', String(temp), 'Temperature — controls randomness', 'temperature'))
      configSpan.appendChild(document.createTextNode(' · '))
      configSpan.appendChild(makeEditable('history', String(histLimit), 'History limit — max messages', 'historyLimit'))
      configSpan.appendChild(document.createTextNode(' · '))
      const toolsSpan = document.createElement('span')
      toolsSpan.textContent = `tools:${toolCount}`
      toolsSpan.title = toolCount > 0 && toolsList ? `Available tools: ${toolsList.join(', ')}` : 'No tools assigned'
      toolsSpan.className = 'cursor-help'
      configSpan.appendChild(toolsSpan)

      // Thinking toggle
      const thinkingEnabled = agentRes.thinking as boolean ?? false
      configSpan.appendChild(document.createTextNode(' · '))
      const thinkLabel = document.createElement('label')
      thinkLabel.className = 'inline-flex items-center gap-0.5 cursor-pointer'
      const thinkCb = document.createElement('input')
      thinkCb.type = 'checkbox'
      thinkCb.checked = thinkingEnabled
      thinkCb.className = 'rounded'
      thinkCb.onchange = async () => {
        await safeFetchJson(`/api/agents/${enc}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thinking: thinkCb.checked }),
        })
        showToast(document.body, `Thinking ${thinkCb.checked ? 'on' : 'off'}`, { position: 'fixed' })
      }
      const thinkText = document.createElement('span')
      thinkText.textContent = 'think'
      thinkLabel.appendChild(thinkCb)
      thinkLabel.appendChild(thinkText)
      configSpan.appendChild(thinkLabel)

      header.appendChild(configSpan)
    } else {
      const kindLabel = document.createElement('span')
      kindLabel.className = 'text-sm text-gray-400 font-normal ml-2'
      kindLabel.textContent = 'human'
      header.appendChild(kindLabel)
    }

    container.appendChild(header)

    // --- Agent prompt (AI) or Description (human) ---
    if (isAI) {
      const { container: promptContainer, textarea: promptTextarea } = createEditableField(
        'Agent Prompt',
        (agentRes.systemPrompt as string) ?? '',
        async (val) => {
          await safeFetchJson(`/api/agents/${enc}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemPrompt: val }),
          })
        },
      )
      container.appendChild(promptContainer)

      // Context & Prompts — per-agent toggles for what gets injected into the LLM
      renderPromptToggles(container, {
        agentName,
        agentEnc: enc,
        agentData: agentRes as Parameters<typeof renderPromptToggles>[1]['agentData'],
        promptTextarea,
      })
    }

    // Description (both AI and human, but primary for human)
    const descValue = (agentRes.description as string) ?? ''
    if (!isAI || descValue) {
      const { container: descContainer } = createEditableField(
        'Description',
        descValue,
        async (val) => {
          await safeFetchJson(`/api/agents/${enc}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: val }),
          })
        },
      )
      container.appendChild(descContainer)
    }

    // --- Memory section (AI only) ---
    if (isAI) {
      const stats = await safeFetchJson<MemoryStats>(`/api/agents/${enc}/memory`)
      if (stats) {
        const memoryRow = document.createElement('div')
        memoryRow.className = 'flex items-center justify-between mb-2 mt-2'
        const memoryLeft = document.createElement('span')
        memoryLeft.className = 'text-xs text-gray-400'
        const totalMsgs = stats.rooms.reduce((sum, r) => sum + r.messageCount, 0)
        let memoryInfo = `MEMORY · ${totalMsgs} msgs · ${stats.rooms.length} rooms`
        if (stats.knownAgents.length > 0) memoryInfo += ` · knows: ${stats.knownAgents.join(', ')}`
        memoryLeft.textContent = memoryInfo
        memoryRow.appendChild(memoryLeft)

        if (totalMsgs > 0) {
          const clearAllBtn = document.createElement('button')
          clearAllBtn.className = 'text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50'
          clearAllBtn.textContent = 'Clear All'
          clearAllBtn.onclick = async () => {
            await safeFetchJson(`/api/agents/${enc}/memory`, { method: 'DELETE' })
            await render()
          }
          memoryRow.appendChild(clearAllBtn)
        }
        container.appendChild(memoryRow)

        // Room list
        for (const room of stats.rooms) {
          const roomDiv = document.createElement('div')
          roomDiv.className = 'border border-gray-100 rounded mb-2'

          const roomHeader = document.createElement('div')
          roomHeader.className = 'flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-50'
          const roomLabel = document.createElement('span')
          roomLabel.className = 'text-sm font-medium text-gray-700'
          const ago = room.lastActiveAt ? formatTimeAgo(room.lastActiveAt) : 'never'
          roomLabel.textContent = `▸ ${room.roomName} (${room.messageCount} msgs, ${ago})`
          roomHeader.appendChild(roomLabel)

          if (room.messageCount > 0) {
            const clearBtn = document.createElement('button')
            clearBtn.className = 'text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50'
            clearBtn.textContent = 'Clear'
            clearBtn.onclick = async (e) => {
              e.stopPropagation()
              await safeFetchJson(`/api/agents/${enc}/memory/${encodeURIComponent(room.roomId)}`, { method: 'DELETE' })
              await render()
            }
            roomHeader.appendChild(clearBtn)
          }

          const messagesContainer = document.createElement('div')
          messagesContainer.className = 'hidden'
          let expanded = false

          roomHeader.onclick = async () => {
            if (expanded) {
              messagesContainer.className = 'hidden'
              roomLabel.textContent = `▸ ${room.roomName} (${room.messageCount} msgs, ${ago})`
              expanded = false
              return
            }
            expanded = true
            roomLabel.textContent = `▾ ${room.roomName} (${room.messageCount} msgs, ${ago})`
            messagesContainer.className = 'border-t border-gray-100 max-h-64 overflow-y-auto'
            messagesContainer.innerHTML = ''

            type MessageItem = { id: string; senderName?: string; content: string; timestamp: number }
            const messages = await safeFetchJson<MessageItem[]>(`/api/agents/${enc}/memory/${encodeURIComponent(room.roomId)}`)
            if (!messages) { messagesContainer.textContent = 'Failed to load'; return }

            const toShow = messages.slice(-10)
            if (messages.length > 10) {
              const loadMore = document.createElement('div')
              loadMore.className = 'px-3 py-1 text-xs text-blue-500 cursor-pointer hover:bg-blue-50'
              loadMore.textContent = `Load ${messages.length - 10} more…`
              loadMore.onclick = () => {
                loadMore.remove()
                const fragment = document.createDocumentFragment()
                for (const msg of messages.slice(0, -10)) fragment.appendChild(renderMemoryMessage(msg, enc, room.roomId))
                messagesContainer.insertBefore(fragment, messagesContainer.firstChild)
              }
              messagesContainer.appendChild(loadMore)
            }
            for (const msg of toShow) messagesContainer.appendChild(renderMemoryMessage(msg, enc, room.roomId))
          }

          roomDiv.appendChild(roomHeader)
          roomDiv.appendChild(messagesContainer)
          container.appendChild(roomDiv)
        }

        if (stats.rooms.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'text-sm text-gray-400 italic'
          empty.textContent = 'No room history'
          container.appendChild(empty)
        }
      }
    }
  }

  void render()
}
