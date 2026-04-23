// ============================================================================
// Macro Editor Modal — Create/edit agent sequence macros.
// ============================================================================

import { createModal } from './detail-modal.ts'
import type { AgentInfo } from './render-types.ts'

interface MacroStepInput {
  agentId: string
  agentName: string
  stepPrompt: string
}

export const openMacroEditorModal = (
  agents: Map<string, AgentInfo>,
  myAgentId: string,
  onSave: (name: string, steps: ReadonlyArray<{ agentId: string; agentName: string; stepPrompt?: string }>, loop: boolean, description?: string) => void,
  existingName?: string,
  existingSteps?: ReadonlyArray<MacroStepInput>,
  existingLoop?: boolean,
  existingDescription?: string,
): void => {
  const steps: MacroStepInput[] = existingSteps
    ? existingSteps.map(s => ({ ...s }))
    : [...agents.values()].map(a => ({ agentId: a.id, agentName: a.name, stepPrompt: '' }))

  const { overlay, scrollBody, footer, close } = createModal({
    title: existingName ? `Edit Macro: ${existingName}` : 'Create Macro',
  })

  const nameInput = document.createElement('input')
  nameInput.className = 'w-full px-3 py-2 border rounded text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-macro-accent'
  nameInput.placeholder = 'Macro name'
  nameInput.value = existingName ?? ''

  const descInput = document.createElement('input')
  descInput.className = 'w-full px-3 py-2 border rounded text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-macro-accent'
  descInput.placeholder = 'Description / goal (optional)'
  descInput.value = existingDescription ?? ''

  const loopRow = document.createElement('label')
  loopRow.className = 'flex items-center gap-2 text-sm mb-3 cursor-pointer'
  const loopCheckbox = document.createElement('input')
  loopCheckbox.type = 'checkbox'
  loopCheckbox.checked = existingLoop ?? false
  loopRow.appendChild(loopCheckbox)
  loopRow.appendChild(document.createTextNode('Loop (repeat continuously)'))

  const stepsContainer = document.createElement('div')
  stepsContainer.className = 'flex-1 overflow-y-auto space-y-2 mb-3 min-h-0'

  const renderSteps = (): void => {
    stepsContainer.innerHTML = ''
    steps.forEach((step, i) => {
      const row = document.createElement('div')
      row.className = 'flex gap-2 items-start bg-surface-muted rounded p-2'

      const num = document.createElement('span')
      num.className = 'text-xs text-text-muted font-mono pt-2 w-5 text-right shrink-0'
      num.textContent = `${i + 1}.`

      const select = document.createElement('select')
      select.className = 'text-sm border rounded px-2 py-1 bg-surface shrink-0'
      for (const agent of agents.values()) {
        const opt = document.createElement('option')
        opt.value = agent.id
        opt.textContent = agent.name
        if (agent.id === step.agentId) opt.selected = true
        select.appendChild(opt)
      }
      select.onchange = () => {
        const selectedAgent = [...agents.values()].find(a => a.id === select.value)
        if (selectedAgent) { step.agentId = selectedAgent.id; step.agentName = selectedAgent.name }
      }

      const promptInput = document.createElement('input')
      promptInput.className = 'flex-1 text-sm border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-macro-accent'
      promptInput.placeholder = 'Step prompt (optional)'
      promptInput.value = step.stepPrompt
      promptInput.oninput = () => { step.stepPrompt = promptInput.value }

      const controls = document.createElement('div')
      controls.className = 'flex flex-col gap-0.5 shrink-0'

      const upBtn = document.createElement('button')
      upBtn.type = 'button'
      upBtn.className = 'text-xs text-text-muted hover:text-text leading-none'
      upBtn.textContent = '▲'
      upBtn.onclick = () => {
        if (i > 0) { [steps[i - 1]!, steps[i]!] = [steps[i]!, steps[i - 1]!]; renderSteps() }
      }

      const downBtn = document.createElement('button')
      downBtn.type = 'button'
      downBtn.className = 'text-xs text-text-muted hover:text-text leading-none'
      downBtn.textContent = '▼'
      downBtn.onclick = () => {
        if (i < steps.length - 1) { [steps[i]!, steps[i + 1]!] = [steps[i + 1]!, steps[i]!]; renderSteps() }
      }

      const dupBtn = document.createElement('button')
      dupBtn.type = 'button'
      dupBtn.className = 'text-xs text-macro-accent-soft hover:text-macro-accent leading-none'
      dupBtn.title = 'Duplicate step'
      dupBtn.textContent = '⧉'
      dupBtn.onclick = () => { steps.splice(i + 1, 0, { ...step, stepPrompt: step.stepPrompt }); renderSteps() }

      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'text-xs text-danger hover:text-danger-hover leading-none'
      removeBtn.textContent = '✕'
      removeBtn.onclick = () => { steps.splice(i, 1); renderSteps() }

      controls.appendChild(upBtn)
      controls.appendChild(downBtn)
      controls.appendChild(dupBtn)
      controls.appendChild(removeBtn)

      row.appendChild(num)
      row.appendChild(select)
      row.appendChild(promptInput)
      row.appendChild(controls)
      stepsContainer.appendChild(row)
    })

    if (steps.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'text-sm text-text-muted text-center py-4'
      empty.textContent = 'No steps yet. Click "+ Add Step" to start building your macro.'
      stepsContainer.appendChild(empty)
    }
  }

  const addStepBtn = document.createElement('button')
  addStepBtn.type = 'button'
  addStepBtn.className = 'text-xs bg-macro-accent-bg text-macro-accent px-3 py-1 rounded hover:bg-macro-accent-border mb-3'
  addStepBtn.textContent = '+ Add Step'
  addStepBtn.onclick = () => {
    const defaultAgent = [...agents.values()].find(a => a.kind === 'ai') ?? [...agents.values()][0]
    if (!defaultAgent) return
    steps.push({ agentId: defaultAgent.id, agentName: defaultAgent.name, stepPrompt: '' })
    renderSteps()
    stepsContainer.scrollTop = stepsContainer.scrollHeight
  }

  // Purple-themed save button for macros (consistent with the chip color).
  const btnRow = document.createElement('div')
  btnRow.className = 'flex justify-end gap-2 w-full'
  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'px-4 py-2 text-sm text-text-subtle'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.onclick = close
  const saveBtn = document.createElement('button')
  saveBtn.className = 'px-4 py-2 text-sm rounded text-white bg-macro-accent'
  saveBtn.textContent = 'Save Macro'
  saveBtn.onclick = () => {
    const macroName = nameInput.value.trim()
    if (!macroName) { nameInput.focus(); return }
    if (steps.length === 0) return
    const cleanSteps = steps.map(s => ({
      agentName: s.agentName,
      ...(s.stepPrompt.trim() ? { stepPrompt: s.stepPrompt.trim() } : {}),
    }))
    const desc = descInput.value.trim() || undefined
    onSave(macroName, cleanSteps, loopCheckbox.checked, desc)
    close()
  }
  btnRow.appendChild(cancelBtn)
  btnRow.appendChild(saveBtn)

  scrollBody.appendChild(nameInput)
  scrollBody.appendChild(descInput)
  scrollBody.appendChild(loopRow)
  scrollBody.appendChild(stepsContainer)
  scrollBody.appendChild(addStepBtn)
  footer.appendChild(btnRow)
  document.body.appendChild(overlay)

  renderSteps()
  nameInput.focus()
}
