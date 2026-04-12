// ============================================================================
// Document Editor Modal — Create and edit document artifact blocks.
// ============================================================================

import { createModal } from './modal.ts'

interface Block {
  id: string
  type: string
  content: string
}

const BLOCK_TYPES = ['paragraph', 'heading1', 'heading2', 'heading3', 'code', 'quote', 'list']

export const openDocumentEditor = (
  artifactId: string,
  title: string,
  blocks: ReadonlyArray<Block>,
  send: (data: unknown) => void,
): void => {
  const modal = createModal({ title: `Edit: ${title}`, width: 'max-w-2xl' })
  const card = modal.body
  card.className += ' max-h-[80vh] flex flex-col'

  const blockList = document.createElement('div')
  blockList.className = 'flex-1 overflow-y-auto space-y-2 mb-3'

  // Working copy of blocks
  const editBlocks: Block[] = blocks.map(b => ({ ...b }))

  const renderBlocks = (): void => {
    blockList.innerHTML = ''
    editBlocks.forEach((block, i) => {
      const row = document.createElement('div')
      row.className = 'flex gap-2 items-start bg-gray-50 rounded p-2'

      // Block type selector
      const typeSelect = document.createElement('select')
      typeSelect.className = 'text-xs border rounded px-1 py-0.5 bg-white shrink-0'
      for (const t of BLOCK_TYPES) {
        const opt = document.createElement('option')
        opt.value = t
        opt.textContent = t
        if (t === block.type) opt.selected = true
        typeSelect.appendChild(opt)
      }
      typeSelect.onchange = () => { block.type = typeSelect.value }

      // Content textarea
      const textarea = document.createElement('textarea')
      textarea.className = 'flex-1 text-xs border rounded px-2 py-1 resize-y focus:outline-none focus:ring-1 focus:ring-blue-300'
      textarea.style.minHeight = '2rem'
      textarea.value = block.content
      textarea.oninput = () => { block.content = textarea.value }

      // Controls
      const controls = document.createElement('div')
      controls.className = 'flex flex-col gap-0.5 shrink-0'

      const upBtn = document.createElement('button')
      upBtn.className = 'text-xs text-gray-400 hover:text-gray-700'
      upBtn.textContent = '▲'
      upBtn.onclick = () => {
        if (i > 0) { [editBlocks[i - 1]!, editBlocks[i]!] = [editBlocks[i]!, editBlocks[i - 1]!]; renderBlocks() }
      }

      const downBtn = document.createElement('button')
      downBtn.className = 'text-xs text-gray-400 hover:text-gray-700'
      downBtn.textContent = '▼'
      downBtn.onclick = () => {
        if (i < editBlocks.length - 1) { [editBlocks[i]!, editBlocks[i + 1]!] = [editBlocks[i + 1]!, editBlocks[i]!]; renderBlocks() }
      }

      const delBtn = document.createElement('button')
      delBtn.className = 'text-xs text-red-400 hover:text-red-600'
      delBtn.textContent = '×'
      delBtn.onclick = () => { editBlocks.splice(i, 1); renderBlocks() }

      controls.appendChild(upBtn)
      controls.appendChild(downBtn)
      controls.appendChild(delBtn)

      row.appendChild(typeSelect)
      row.appendChild(textarea)
      row.appendChild(controls)
      blockList.appendChild(row)
    })

    if (editBlocks.length === 0) {
      blockList.innerHTML = '<div class="text-xs text-gray-400 text-center py-4">No blocks. Click "Add Block" to start.</div>'
    }
  }

  const addBtn = document.createElement('button')
  addBtn.className = 'text-xs bg-blue-100 text-blue-700 px-3 py-1 rounded hover:bg-blue-200 mb-3'
  addBtn.textContent = '+ Add Block'
  addBtn.onclick = () => {
    editBlocks.push({ id: crypto.randomUUID(), type: 'paragraph', content: '' })
    renderBlocks()
    blockList.scrollTop = blockList.scrollHeight
  }

  const saveBtn = document.createElement('button')
  saveBtn.className = 'text-xs px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600'
  saveBtn.textContent = 'Save'
  saveBtn.onclick = () => {
    // Compare with original blocks and send appropriate operations
    // Simplest approach: delete all blocks, then insert all in order
    const originalIds = new Set(blocks.map(b => b.id))

    // Delete blocks that were removed
    for (const orig of blocks) {
      if (!editBlocks.find(b => b.id === orig.id)) {
        send({ type: 'update_artifact', artifactId, body: { op: 'delete_block', blockId: orig.id } })
      }
    }

    // Update existing blocks and insert new ones
    for (const block of editBlocks) {
      if (originalIds.has(block.id)) {
        // Update existing
        send({ type: 'update_artifact', artifactId, body: { op: 'update_block', blockId: block.id, blockType: block.type, content: block.content } })
      } else {
        // Insert new
        send({ type: 'update_artifact', artifactId, body: { op: 'insert_block', blockType: block.type, content: block.content, id: block.id } })
      }
    }

    modal.close()
  }

  const btnRow = document.createElement('div')
  btnRow.className = 'flex justify-end'
  btnRow.appendChild(saveBtn)

  card.appendChild(blockList)
  card.appendChild(addBtn)
  card.appendChild(btnRow)
  document.body.appendChild(modal.overlay)

  renderBlocks()
}
