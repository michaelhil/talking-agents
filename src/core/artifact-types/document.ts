// ============================================================================
// Document Artifact Type
//
// A collaborative structured document consisting of ordered blocks.
// Each block has a stable UUID so concurrent agents can insert/update/delete
// safely by referencing block IDs rather than positions.
//
// Supported operations (via body.op):
//   insert_block — add a new block, optionally after a specific existing block
//   update_block — update content and/or type of an existing block
//   delete_block — remove a block by ID
//   move_block   — reorder a block (move after another block, or to the front)
//
// No auto-resolve. postSystemMessageOn omits 'updated' to prevent streaming noise —
// agents receive the artifact in context and can observe changes there.
// ============================================================================

import type { Artifact, ArtifactTypeDefinition, ArtifactUpdateConfig, ArtifactUpdateResult, BlockType, DocumentBlock, DocumentBody } from '../types/artifact.ts'

const DOCUMENT_CONTEXT_MAX_CHARS = 6_000

// DocumentBody has typed fields, but ArtifactUpdateResult.newBody uses Record<string,unknown>.
// This cast bridges the two without losing structural safety in this module.
const asBody = (b: DocumentBody): Record<string, unknown> => b as unknown as Record<string, unknown>

const blockTypePrefix = (type: BlockType): string => {
  switch (type) {
    case 'heading1': return '# '
    case 'heading2': return '## '
    case 'heading3': return '### '
    case 'quote': return '> '
    case 'list': return '- '
    case 'code': return '```\n'
    case 'paragraph': return ''
  }
}

const blockTypeSuffix = (type: BlockType): string =>
  type === 'code' ? '\n```' : ''

const renderBlock = (block: DocumentBlock): string =>
  `${blockTypePrefix(block.type)}${block.content}${blockTypeSuffix(block.type)}`

export const documentArtifactType: ArtifactTypeDefinition = {
  type: 'document',
  description: 'A collaborative structured document with ordered blocks (headings, paragraphs, code, etc.). Agents write sections by inserting or updating blocks.',

  bodySchema: {
    type: 'object',
    properties: {
      blocks: {
        type: 'array',
        description: 'The ordered document blocks',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable block UUID' },
            type: {
              type: 'string',
              enum: ['heading1', 'heading2', 'heading3', 'paragraph', 'code', 'quote', 'list'],
            },
            content: { type: 'string' },
          },
          required: ['id', 'type', 'content'],
        },
      },
      // Operation fields — consumed by onUpdate, never stored
      op: {
        type: 'string',
        enum: ['insert_block', 'update_block', 'delete_block', 'move_block'],
        description: 'Operation to perform on the document',
      },
      blockType: { type: 'string', description: 'Block type for insert_block' },
      content: { type: 'string', description: 'Block content for insert_block or update_block' },
      afterBlockId: { type: 'string', description: 'Insert/move after this block ID; omit for start of document' },
      blockId: { type: 'string', description: 'Target block ID for update_block, delete_block, move_block' },
      id: { type: 'string', description: 'Optional pre-generated block ID for insert_block (useful for streaming)' },
    },
    required: ['blocks'],
  },

  validateBody: (body: unknown): boolean => {
    if (!body || typeof body !== 'object') return false
    const blocks = (body as { blocks?: unknown }).blocks
    if (!Array.isArray(blocks)) return false
    for (const b of blocks) {
      if (!b || typeof b !== 'object') return false
      const r = b as Record<string, unknown>
      if (typeof r.id !== 'string' || typeof r.type !== 'string' || typeof r.content !== 'string') return false
    }
    return true
  },

  onUpdate: (artifact: Artifact, updates: ArtifactUpdateConfig): ArtifactUpdateResult | void => {
    const body = updates.body
    if (!body) return

    const currentBody = artifact.body as unknown as DocumentBody
    const blocks = [...(currentBody.blocks ?? [])]
    const op = body.op as string | undefined

    if (op === 'insert_block') {
      const blockType = body.blockType as BlockType | undefined
      const content = body.content as string | undefined
      if (!blockType || content === undefined) return { newBody: asBody(currentBody) }

      const newBlock: DocumentBlock = {
        id: (body.id as string | undefined) ?? crypto.randomUUID(),
        type: blockType,
        content,
      }

      const afterBlockId = body.afterBlockId as string | undefined
      if (!afterBlockId) {
        // No anchor specified — append at end
        return { newBody: asBody({ ...currentBody, blocks: [...blocks, newBlock] }) }
      }
      const idx = blocks.findIndex(b => b.id === afterBlockId)
      if (idx === -1) {
        // afterBlockId not found — append at end
        return { newBody: asBody({ ...currentBody, blocks: [...blocks, newBlock] }) }
      }
      const updated = [...blocks.slice(0, idx + 1), newBlock, ...blocks.slice(idx + 1)]
      return { newBody: { ...currentBody, blocks: updated } }
    }

    if (op === 'update_block') {
      const blockId = body.blockId as string | undefined
      if (!blockId) return { newBody: asBody(currentBody) }
      const idx = blocks.findIndex(b => b.id === blockId)
      if (idx === -1) return { newBody: asBody(currentBody) }

      const updated = blocks.map((b, i) => i !== idx ? b : {
        ...b,
        ...(body.blockType !== undefined ? { type: body.blockType as BlockType } : {}),
        ...(body.content !== undefined ? { content: body.content as string } : {}),
      })
      return { newBody: asBody({ ...currentBody, blocks: updated }) }
    }

    if (op === 'delete_block') {
      const blockId = body.blockId as string | undefined
      if (!blockId) return { newBody: asBody(currentBody) }
      const filtered = blocks.filter(b => b.id !== blockId)
      if (filtered.length === blocks.length) return { newBody: asBody(currentBody) }  // not found — no-op
      return { newBody: asBody({ ...currentBody, blocks: filtered }) }
    }

    if (op === 'move_block') {
      const blockId = body.blockId as string | undefined
      if (!blockId) return { newBody: asBody(currentBody) }
      const idx = blocks.findIndex(b => b.id === blockId)
      if (idx === -1) return { newBody: asBody(currentBody) }

      const [block] = blocks.splice(idx, 1)
      const afterBlockId = body.afterBlockId as string | undefined
      if (!afterBlockId) {
        return { newBody: asBody({ ...currentBody, blocks: [block!, ...blocks] }) }
      }
      const targetIdx = blocks.findIndex(b => b.id === afterBlockId)
      if (targetIdx === -1) {
        return { newBody: asBody({ ...currentBody, blocks: [...blocks, block!] }) }
      }
      blocks.splice(targetIdx + 1, 0, block!)
      return { newBody: asBody({ ...currentBody, blocks }) }
    }

    // Unknown or no op — no-op to prevent field pollution
    if (op !== undefined) return { newBody: asBody(currentBody) }
    return undefined
  },

  formatForContext: (artifact: Artifact): string => {
    const body = artifact.body as unknown as DocumentBody
    const blocks = body.blocks ?? []
    const header = `Document: ${artifact.title} [id: ${artifact.id}] (${blocks.length} block${blocks.length === 1 ? '' : 's'})`
    if (blocks.length === 0) return `${header}\n  (empty document)`

    const lines: string[] = [header]
    let charCount = header.length + 1
    let truncated = false

    for (const block of blocks) {
      const rendered = renderBlock(block)
      const lineWithId = `[${block.id.slice(0, 8)}] ${rendered}`
      if (charCount + lineWithId.length + 1 > DOCUMENT_CONTEXT_MAX_CHARS) {
        lines.push(`  ... [${blocks.length - lines.length + 1} more blocks omitted]`)
        truncated = true
        break
      }
      lines.push(lineWithId)
      charCount += lineWithId.length + 1
    }

    if (!truncated) {
      lines.push(`\nEdit with: update_artifact { artifactId: "${artifact.id}", body: { op: "insert_block"|"update_block"|"delete_block"|"move_block", ... } }`)
    }

    return lines.join('\n')
  },

  // No formatUpdateMessage — streaming produces many rapid updates; not useful as notifications
  // postSystemMessageOn omits 'updated' to avoid flooding rooms during streaming writes
  postSystemMessageOn: ['added', 'removed'],
}
