// ============================================================================
// Workspace — modal hosting the room's artifacts (task lists, polls,
// documents, mermaid diagrams). Replaces the previous bottom-anchored
// resizable pane with a master/detail modal opened from a toolbar button.
//
// Public surface:
//   - show()/hide()           — toggle the toolbar button visibility
//   - setCount(n)             — update the badge on the toolbar button
//   - open()                  — open the master/detail modal
// ============================================================================

import { createMasterDetailModal, createButton, createInput } from './modals/detail-modal.ts'
import { renderArtifacts } from './render/render-rooms.ts'
import type { ArtifactInfo, ArtifactAction } from './render/render-types.ts'
import { $selectedRoomArtifacts, $myAgentId, $selectedRoomId } from './stores.ts'

export interface Workspace {
  readonly show: () => void
  readonly hide: () => void
  readonly setCount: (n: number) => void
  readonly open: () => void
}

export interface WorkspaceDeps {
  readonly button: HTMLButtonElement
  readonly send: (data: unknown) => void
  readonly roomIdToName: (roomId: string) => string | undefined
  readonly onAction: (action: ArtifactAction) => void
}

const DEFAULT_BODIES: Readonly<Record<string, Record<string, unknown>>> = {
  task_list: { tasks: [] },
  document: { blocks: [] },
  poll: {
    question: '',
    options: [{ id: '1', text: 'Option 1' }, { id: '2', text: 'Option 2' }],
    allowMultiple: false,
    votes: {},
  },
  mermaid: { source: 'graph TD\n  A-->B' },
  map: {
    view: { center: [60.32, 24.97], zoom: 8 },
    features: [
      { type: 'marker', lat: 60.32, lng: 24.97, label: 'EFHK Helsinki' },
    ],
  },
}

export const createWorkspace = (deps: WorkspaceDeps): Workspace => {
  const { button, send, roomIdToName, onAction } = deps
  let count = 0

  const updateBadge = (): void => {
    // Hide the badge when count is 0; otherwise show beside the icon.
    let badge = button.querySelector<HTMLSpanElement>('.workspace-badge')
    if (count === 0) { badge?.remove(); return }
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'workspace-badge'
      button.appendChild(badge)
    }
    badge.textContent = String(count)
  }

  // --- Modal builder ---
  const open = (): void => {
    const roomId = $selectedRoomId.get()
    if (!roomId) return
    const roomName = roomIdToName(roomId)
    if (!roomName) return

    const modal = createMasterDetailModal({ title: 'Workspace', height: '80vh' })
    document.body.appendChild(modal.overlay)

    // --- Add-row (full-width band above the master/detail split). The
    //     master/detail container is modal.scrollBody; we prepend the
    //     add-row to it so it sits above both panes, then re-set
    //     flex-direction: column on scrollBody so the row stacks above the
    //     master/detail flex row. ---
    modal.scrollBody.style.flexDirection = 'column'

    const addRow = document.createElement('div')
    addRow.className = 'flex items-center gap-2 px-4 py-2 border-b border-border flex-shrink-0'

    const typeSelect = document.createElement('select')
    typeSelect.className = 'input'
    typeSelect.style.width = 'auto'
    for (const [value, label] of [
      ['task_list', 'Task List'],
      ['document', 'Document'],
      ['poll', 'Poll'],
      ['mermaid', 'Mermaid'],
      ['map', 'Map'],
    ] as const) {
      const opt = document.createElement('option')
      opt.value = value; opt.textContent = label
      typeSelect.appendChild(opt)
    }

    const titleInput = createInput({ placeholder: 'Title…', className: 'flex-1' })

    const submit = (): void => {
      const title = titleInput.value.trim()
      if (!title) return
      const artifactType = typeSelect.value
      send({
        type: 'add_artifact',
        artifactType,
        title,
        body: DEFAULT_BODIES[artifactType] ?? {},
        scope: [roomName],
      })
      titleInput.value = ''
    }

    const addBtn = createButton({ variant: 'primary', label: 'Add', onClick: submit })

    titleInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit() }
      if (e.key === 'Escape') { titleInput.value = ''; titleInput.blur() }
    }

    addRow.appendChild(typeSelect)
    addRow.appendChild(titleInput)
    addRow.appendChild(addBtn)

    // The master/detail panes are already children of scrollBody; prepend
    // the add-row so it renders above them.
    modal.scrollBody.insertBefore(addRow, modal.scrollBody.firstChild)

    // Wrap master+detail in a flex-row so they sit side-by-side under the
    // add-row band. They were created as children of scrollBody by the
    // helper; we move them into a wrapper row so the column layout works.
    const splitRow = document.createElement('div')
    splitRow.style.flex = '1 1 0'
    splitRow.style.display = 'flex'
    splitRow.style.minHeight = '0'
    splitRow.style.overflow = 'hidden'
    splitRow.appendChild(modal.master)
    splitRow.appendChild(modal.detail)
    modal.scrollBody.appendChild(splitRow)

    // --- Master pane: list of artifacts ---
    let activeId: string | null = null
    const masterList = document.createElement('div')
    masterList.style.flex = '1 1 0'
    masterList.style.minHeight = '0'
    masterList.style.overflowY = 'auto'
    modal.master.appendChild(masterList)

    // --- Detail pane: padded body, swapped per selection ---
    const detailInner = document.createElement('div')
    detailInner.className = 'px-4 py-3'
    detailInner.innerHTML = '<div class="text-xs text-text-muted">Select an artifact to view, or add one above.</div>'
    modal.detail.appendChild(detailInner)

    const renderDetail = (artifact: ArtifactInfo | null): void => {
      detailInner.innerHTML = ''
      if (!artifact) {
        detailInner.innerHTML = '<div class="text-xs text-text-muted">Select an artifact to view, or add one above.</div>'
        return
      }
      // Render the single artifact via the existing renderer (it iterates
      // an array, so wrap in a one-element array).
      renderArtifacts(detailInner, [artifact], $myAgentId.get() ?? '', onAction)
    }

    const renderMaster = (artifacts: ReadonlyArray<ArtifactInfo>): void => {
      masterList.innerHTML = ''
      if (artifacts.length === 0) {
        masterList.innerHTML = '<div class="text-xs text-text-muted px-3 py-2">No artifacts yet.</div>'
        renderDetail(null)
        return
      }
      // Auto-select the first artifact if nothing is active or the active
      // one was removed.
      if (!activeId || !artifacts.find(a => a.id === activeId)) {
        activeId = artifacts[0]!.id
      }
      for (const a of artifacts) {
        const row = document.createElement('button')
        const isActive = a.id === activeId
        row.className = `w-full text-left text-xs py-2 px-3 cursor-pointer truncate interactive ${isActive ? 'bg-surface-muted text-text-strong' : 'text-text hover:bg-surface-muted'}`
        const typeLabel = a.type.replace('_', ' ')
        row.title = `${a.title} (${typeLabel})`
        row.innerHTML = `<div class="font-medium truncate">${escapeHtml(a.title)}</div><div class="text-text-subtle text-[10px]">${typeLabel}</div>`
        row.onclick = () => {
          activeId = a.id
          renderMaster(artifacts)
        }
        masterList.appendChild(row)
      }
      const active = artifacts.find(a => a.id === activeId) ?? null
      renderDetail(active)
    }

    // Initial render from current atom state.
    const filterActive = (list: ReadonlyArray<ArtifactInfo>): ArtifactInfo[] =>
      list.filter(a => !a.resolvedAt)
    renderMaster(filterActive($selectedRoomArtifacts.get()))

    // Live updates while modal is open.
    const unsubscribe = $selectedRoomArtifacts.subscribe((list) => {
      renderMaster(filterActive(list))
    })

    // Cleanup when the overlay is removed (× / outside click / programmatic).
    const removalObserver = new MutationObserver(() => {
      if (!modal.overlay.isConnected) {
        unsubscribe()
        removalObserver.disconnect()
      }
    })
    removalObserver.observe(document.body, { childList: true })
  }

  return {
    show: () => button.classList.remove('hidden'),
    hide: () => button.classList.add('hidden'),
    setCount: (n) => { count = n; updateBadge() },
    open,
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
