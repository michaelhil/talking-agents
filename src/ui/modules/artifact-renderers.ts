// ============================================================================
// Artifact Renderers — type-specific rendering for workspace artifacts.
//
// Extracted from ui-renderer.ts. Each artifact type has its own render function.
// ============================================================================

import type { ArtifactInfo, ArtifactAction, TaskItem, PollOption } from './render-types.ts'

// === Shared helpers ===

const createArtifactHeader = (
  title: string,
  titleClass: string,
  onRemove: () => void,
  extra?: HTMLElement[],
): HTMLElement => {
  const header = document.createElement('div')
  header.className = 'flex items-center gap-1'
  const titleEl = document.createElement('span')
  titleEl.className = `text-xs ${titleClass} flex-1`
  titleEl.textContent = title
  header.appendChild(titleEl)
  for (const el of (extra ?? [])) header.appendChild(el)
  const removeBtn = document.createElement('button')
  removeBtn.className = 'text-xs text-danger hover:text-danger opacity-0 group-hover:opacity-100 ml-1 flex-shrink-0'
  removeBtn.textContent = '✕'
  removeBtn.onclick = onRemove
  header.appendChild(removeBtn)
  return header
}

// === Task List ===

export const renderTaskListArtifact = (
  artifact: ArtifactInfo,
  onAction: (action: ArtifactAction) => void,
): HTMLElement => {
  const tasks = ((artifact.body as { tasks?: TaskItem[] })?.tasks ?? [])
  const completed = tasks.filter(t => t.status === 'completed').length
  const wrap = document.createElement('div')
  wrap.className = 'group space-y-0.5'

  const progress = document.createElement('span')
  progress.className = 'text-xs text-text-muted'
  progress.textContent = tasks.length > 0 ? `${completed}/${tasks.length}` : '0 tasks'

  wrap.appendChild(createArtifactHeader(
    artifact.title, 'font-medium text-text',
    () => onAction({ kind: 'remove', artifactId: artifact.id }),
    [progress],
  ))

  for (const task of tasks) {
    const row = document.createElement('div')
    row.className = 'flex items-center gap-1.5 pl-2 text-xs'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = task.status === 'completed'
    cb.className = 'rounded flex-shrink-0'
    cb.onchange = () => onAction({ kind: 'complete_task', artifactId: artifact.id, taskId: task.id, completed: cb.checked })
    const label = document.createElement('span')
    label.className = `flex-1 ${task.status === 'completed' ? 'line-through text-text-muted' : task.status === 'blocked' ? 'text-danger' : 'text-text'}`
    label.textContent = task.content
    row.appendChild(cb)
    row.appendChild(label)
    if (task.assignee) {
      const badge = document.createElement('span')
      badge.className = 'text-xs bg-surface-muted text-accent px-1 rounded flex-shrink-0'
      badge.textContent = task.assignee
      row.appendChild(badge)
    }
    wrap.appendChild(row)
  }

  if (!artifact.resolution) {
    const addRow = document.createElement('div')
    addRow.className = 'flex items-center gap-1 pl-2 pt-0.5'
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'Add task…'
    input.className = 'flex-1 text-xs border-b border-transparent hover:border-border focus:border-accent bg-transparent py-0.5 focus:outline-none'
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation()
        const content = input.value.trim()
        if (!content) return
        onAction({ kind: 'add_task', artifactId: artifact.id, content })
        input.value = ''
      }
    }
    addRow.appendChild(input)
    wrap.appendChild(addRow)
  } else {
    const res = document.createElement('div')
    res.className = 'text-xs text-success pl-2 italic'
    res.textContent = `✓ ${artifact.resolution}`
    wrap.appendChild(res)
  }
  return wrap
}

// === Poll ===

export const renderPollArtifact = (
  artifact: ArtifactInfo,
  myAgentId: string,
  onAction: (action: ArtifactAction) => void,
): HTMLElement => {
  const body = artifact.body as { question?: string; options?: PollOption[] }
  const wrap = document.createElement('div')
  wrap.className = 'group space-y-1'

  wrap.appendChild(createArtifactHeader(
    artifact.title, 'font-medium text-text',
    () => onAction({ kind: 'remove', artifactId: artifact.id }),
  ))

  if (body.question) {
    const q = document.createElement('div')
    q.className = 'text-xs text-text-subtle pl-2 italic'
    q.textContent = body.question
    wrap.appendChild(q)
  }

  for (const opt of (body.options ?? [])) {
    const row = document.createElement('div')
    row.className = 'flex items-center gap-1.5 pl-2 text-xs'
    const hasVoted = opt.votes.includes(myAgentId)
    const voteBtn = document.createElement('button')
    voteBtn.className = `px-1.5 py-0.5 rounded text-xs flex-shrink-0 ${hasVoted ? 'bg-surface-strong text-accent font-medium' : 'bg-surface-strong text-text-subtle hover:bg-border'}`
    voteBtn.textContent = hasVoted ? '✓' : 'Vote'
    voteBtn.disabled = artifact.resolvedAt !== undefined
    voteBtn.onclick = () => onAction({ kind: 'cast_vote', artifactId: artifact.id, optionId: opt.id })
    const optLabel = document.createElement('span')
    optLabel.className = 'flex-1 text-text'
    optLabel.textContent = opt.text
    const count = document.createElement('span')
    count.className = 'text-text-muted flex-shrink-0'
    count.textContent = `${opt.votes.length}`
    row.appendChild(voteBtn)
    row.appendChild(optLabel)
    row.appendChild(count)
    wrap.appendChild(row)
  }

  if (artifact.resolution) {
    const res = document.createElement('div')
    res.className = 'text-xs text-success pl-2 italic'
    res.textContent = `✓ ${artifact.resolution}`
    wrap.appendChild(res)
  }
  return wrap
}

// === Macro ===

export const renderMacroArtifact = (
  artifact: ArtifactInfo,
  onAction: (action: ArtifactAction) => void,
): HTMLElement => {
  const body = artifact.body as { steps?: Array<{ agentName: string }>; loop?: boolean }
  const wrap = document.createElement('div')
  wrap.className = 'group'
  const row = document.createElement('div')
  row.className = 'flex items-center gap-1 text-xs'
  const titleEl = document.createElement('span')
  titleEl.className = 'font-medium text-macro-accent flex-1'
  titleEl.textContent = artifact.title
  const steps = (body.steps ?? []).map(s => s.agentName).join(' → ')
  const stepsEl = document.createElement('span')
  stepsEl.className = 'text-text-muted truncate max-w-[120px]'
  stepsEl.title = steps
  stepsEl.textContent = steps
  const loopEl = body.loop ? document.createElement('span') : null
  if (loopEl) { loopEl.className = 'text-macro-accent-soft flex-shrink-0'; loopEl.textContent = '↻' }
  const removeBtn = document.createElement('button')
  removeBtn.className = 'text-xs text-danger hover:text-danger opacity-0 group-hover:opacity-100 flex-shrink-0'
  removeBtn.textContent = '✕'
  removeBtn.onclick = () => onAction({ kind: 'remove', artifactId: artifact.id })
  row.appendChild(titleEl)
  row.appendChild(stepsEl)
  if (loopEl) row.appendChild(loopEl)
  row.appendChild(removeBtn)
  wrap.appendChild(row)
  return wrap
}

// === Document ===

const MAX_VISIBLE_BLOCKS = 20

export const renderDocumentArtifact = (
  artifact: ArtifactInfo,
  onAction: (action: ArtifactAction) => void,
): HTMLElement => {
  const body = artifact.body as { blocks?: Array<{ id: string; type: string; content: string }> }
  const allBlocks = body.blocks ?? []
  const blocks = allBlocks.slice(-MAX_VISIBLE_BLOCKS)
  const wrap = document.createElement('div')
  wrap.className = 'group'

  const countEl = document.createElement('span')
  countEl.className = 'text-text-muted flex-shrink-0'
  countEl.textContent = `${allBlocks.length} block${allBlocks.length === 1 ? '' : 's'}`
  const editBtn = document.createElement('button')
  editBtn.className = 'text-xs text-accent hover:text-accent-hover opacity-0 group-hover:opacity-100 flex-shrink-0'
  editBtn.textContent = 'edit'
  editBtn.onclick = () => onAction({ kind: 'edit_document', artifactId: artifact.id, title: artifact.title, blocks: allBlocks })

  const header = createArtifactHeader(
    artifact.title, 'font-medium text-indigo-700',
    () => onAction({ kind: 'remove', artifactId: artifact.id }),
    [countEl, editBtn],
  )
  header.className += ' mb-1'
  wrap.appendChild(header)

  if (allBlocks.length > MAX_VISIBLE_BLOCKS) {
    const moreEl = document.createElement('div')
    moreEl.className = 'text-xs text-text-muted italic mb-1'
    moreEl.textContent = `… ${allBlocks.length - MAX_VISIBLE_BLOCKS} earlier blocks`
    wrap.appendChild(moreEl)
  }

  for (const block of blocks) {
    const blockEl = document.createElement('div')
    blockEl.className = 'text-xs text-text leading-snug mb-0.5'
    switch (block.type) {
      case 'heading1': blockEl.className = 'text-sm font-bold text-text-strong mb-0.5'; blockEl.textContent = block.content; break
      case 'heading2': blockEl.className = 'text-xs font-semibold text-text-strong mb-0.5'; blockEl.textContent = block.content; break
      case 'heading3': blockEl.className = 'text-xs font-medium text-text mb-0.5'; blockEl.textContent = block.content; break
      case 'code': {
        const pre = document.createElement('pre')
        pre.className = 'text-xs bg-surface-muted rounded p-1 mb-0.5 overflow-x-auto whitespace-pre-wrap break-words'
        pre.textContent = block.content
        wrap.appendChild(pre)
        continue
      }
      case 'quote': blockEl.className = 'text-xs text-text border-l-2 border-border-strong pl-2 italic mb-0.5'; blockEl.textContent = block.content; break
      case 'list': blockEl.className = 'text-xs text-text mb-0.5'; blockEl.textContent = `• ${block.content}`; break
      default: blockEl.textContent = block.content
    }
    wrap.appendChild(blockEl)
  }

  if (allBlocks.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'text-xs text-text-muted italic'
    empty.textContent = '(empty document)'
    wrap.appendChild(empty)
  }
  return wrap
}

// === Mermaid ===

import { renderMermaidSource } from './render-mermaid.ts'

export const renderMermaidArtifact = (
  artifact: ArtifactInfo,
  onAction: (action: ArtifactAction) => void,
): HTMLElement => {
  const div = document.createElement('div')
  div.className = 'group relative'
  const header = document.createElement('div')
  header.className = 'flex items-center gap-2 mb-1'
  const title = document.createElement('span')
  title.className = 'text-xs font-medium text-teal-700'
  title.textContent = artifact.title
  header.appendChild(title)
  const removeBtn = document.createElement('button')
  removeBtn.className = 'text-xs text-danger hover:text-danger-hover opacity-0 group-hover:opacity-100 ml-auto'
  removeBtn.textContent = '✕'
  removeBtn.onclick = () => onAction({ kind: 'remove', artifactId: artifact.id })
  header.appendChild(removeBtn)
  const container = document.createElement('div')
  container.className = 'overflow-x-auto bg-surface rounded border p-2'
  const source = (artifact.body as { source?: string })?.source ?? ''
  void renderMermaidSource(container, source)
  div.appendChild(header)
  div.appendChild(container)
  return div
}

// === Generic fallback ===

export const renderGenericArtifact = (
  artifact: ArtifactInfo,
  onAction: (action: ArtifactAction) => void,
): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'group flex items-center gap-1 text-xs'
  const titleEl = document.createElement('span')
  titleEl.className = 'flex-1 text-text'
  titleEl.textContent = artifact.title
  const typeEl = document.createElement('span')
  typeEl.className = 'text-text-muted flex-shrink-0'
  typeEl.textContent = `[${artifact.type}]`
  const removeBtn = document.createElement('button')
  removeBtn.className = 'text-xs text-danger hover:text-danger opacity-0 group-hover:opacity-100 flex-shrink-0'
  removeBtn.textContent = '✕'
  removeBtn.onclick = () => onAction({ kind: 'remove', artifactId: artifact.id })
  wrap.appendChild(titleEl)
  wrap.appendChild(typeEl)
  wrap.appendChild(removeBtn)
  return wrap
}
