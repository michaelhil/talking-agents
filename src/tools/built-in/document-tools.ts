// ============================================================================
// Document Tools — write_document_section
//
// write_document_section: Streams LLM output into a document artifact,
// inserting blocks one-by-one as paragraphs/headings are completed.
// This gives collaborators a live view as content is written.
//
// parseStreamedBlocks: Pure helper that classifies accumulated text into
// document blocks based on Markdown-like prefix syntax.
// ============================================================================

import type { ArtifactStore, BlockType, DocumentBody, Tool, ToolContext, ToolResult } from '../../core/types.ts'

// === parseStreamedBlocks ===
// Splits accumulated text into discrete document blocks.
// Called on paragraph-boundary flushes, not on raw deltas.

interface ParsedBlock {
  readonly type: BlockType
  readonly content: string
}

export const parseStreamedBlocks = (text: string): ReadonlyArray<ParsedBlock> => {
  const lines = text.split('\n')
  const results: ParsedBlock[] = []
  let codeAccumulator: string[] = []
  let inCodeBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // Code block fence
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeAccumulator = []
      } else {
        inCodeBlock = false
        results.push({ type: 'code', content: codeAccumulator.join('\n') })
        codeAccumulator = []
      }
      continue
    }

    if (inCodeBlock) {
      codeAccumulator.push(line)
      continue
    }

    if (!line.trim()) continue

    if (line.startsWith('### ')) {
      results.push({ type: 'heading3', content: line.slice(4).trim() })
    } else if (line.startsWith('## ')) {
      results.push({ type: 'heading2', content: line.slice(3).trim() })
    } else if (line.startsWith('# ')) {
      results.push({ type: 'heading1', content: line.slice(2).trim() })
    } else if (line.startsWith('> ')) {
      results.push({ type: 'quote', content: line.slice(2).trim() })
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      results.push({ type: 'list', content: line.slice(2).trim() })
    } else {
      results.push({ type: 'paragraph', content: line.trim() })
    }
  }

  // Unclosed code block — flush as code anyway
  if (inCodeBlock && codeAccumulator.length > 0) {
    results.push({ type: 'code', content: codeAccumulator.join('\n') })
  }

  return results
}

// === write_document_section tool factory ===

export const createWriteDocumentSectionTool = (artifactStore: ArtifactStore): Tool => ({
  name: 'write_document_section',
  description: 'Streams LLM-generated content into a document artifact, inserting blocks one-by-one as they complete. Use this to collaboratively author or extend a document in real time.',
  usage: 'Use when you need to write a section of a document artifact. The prompt describes what to write. Content is inserted after the specified anchor block (or at the end if not specified). Only works on artifacts of type "document". The tool streams output — other agents can observe blocks appearing live.',
  returns: '{ artifactId, blocksInserted, lastBlockId } — the artifact ID, count of blocks written, and ID of the last inserted block.',
  parameters: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'ID of the document artifact to write into' },
      prompt: { type: 'string', description: 'What to write — instructions for the LLM' },
      afterBlockId: { type: 'string', description: 'Insert content after this block ID. Omit to append at the end.' },
      systemPrompt: { type: 'string', description: 'Optional system prompt override for the writing LLM call' },
    },
    required: ['artifactId', 'prompt'],
  },

  execute: async (params, context: ToolContext): Promise<ToolResult> => {
    const artifactId = params.artifactId as string
    const prompt = params.prompt as string
    const afterBlockId = params.afterBlockId as string | undefined
    const systemOverride = params.systemPrompt as string | undefined

    // Validate llmStream is available
    if (!context.llmStream) {
      return { success: false, error: 'write_document_section requires a streaming-capable LLM context' }
    }

    // Look up and validate artifact
    const artifact = artifactStore.get(artifactId)
    if (!artifact) {
      return { success: false, error: `Document artifact "${artifactId}" not found` }
    }
    if (artifact.type !== 'document') {
      return { success: false, error: `Artifact "${artifactId}" is type "${artifact.type}", expected "document"` }
    }

    // Scope check — caller must be in one of the artifact's scoped rooms
    if (artifact.scope.length > 0 && context.roomId && !artifact.scope.includes(context.roomId)) {
      return { success: false, error: `Document "${artifact.title}" is not scoped to the current room` }
    }

    const systemPrompt = systemOverride ?? 'You are a technical writer. Write clear, well-structured content. Use Markdown formatting: # for h1, ## for h2, ### for h3, > for quotes, - for list items, ``` for code blocks. Write only the content requested, no preamble.'

    // Determine insertion anchor: start from afterBlockId or last block in document
    const body = artifact.body as unknown as DocumentBody
    const blocks = body.blocks ?? []
    let currentAnchor = afterBlockId ?? (blocks.length > 0 ? blocks[blocks.length - 1]!.id : undefined)

    let buffer = ''
    let blocksInserted = 0
    let lastBlockId: string | undefined

    // Stream LLM output, flush complete paragraphs on double-newline boundaries
    try {
      for await (const delta of context.llmStream({ systemPrompt, messages: [{ role: 'user', content: prompt }] })) {
        buffer += delta

        // Flush on paragraph boundaries (double newline) or heading/code fence starts
        let flushIdx: number
        while ((flushIdx = findFlushBoundary(buffer)) !== -1) {
          const chunk = buffer.slice(0, flushIdx)
          buffer = buffer.slice(flushIdx)

          const parsedBlocks = parseStreamedBlocks(chunk)
          for (const parsed of parsedBlocks) {
            if (!parsed.content.trim()) continue
            const blockId = crypto.randomUUID()
            try {
              artifactStore.update(artifactId, {
                body: {
                  op: 'insert_block',
                  id: blockId,
                  blockType: parsed.type,
                  content: parsed.content,
                  afterBlockId: currentAnchor,
                },
              }, context)
            } catch {
              // Non-fatal: block insert failed (e.g. artifact deleted mid-stream) — continue
              continue
            }
            currentAnchor = blockId
            lastBlockId = blockId
            blocksInserted++
          }
        }
      }

      // Flush any remaining buffer
      if (buffer.trim()) {
        const parsedBlocks = parseStreamedBlocks(buffer)
        for (const parsed of parsedBlocks) {
          if (!parsed.content.trim()) continue
          const blockId = crypto.randomUUID()
          try {
            artifactStore.update(artifactId, {
              body: {
                op: 'insert_block',
                id: blockId,
                blockType: parsed.type,
                content: parsed.content,
                afterBlockId: currentAnchor,
              },
            }, context)
          } catch {
            continue
          }
          currentAnchor = blockId
          lastBlockId = blockId
          blocksInserted++
        }
      }
    } catch (err) {
      if (blocksInserted > 0) {
        // Partial success — return what we managed to write
        return {
          success: true,
          data: { artifactId, blocksInserted, lastBlockId, warning: `Stream ended early: ${err instanceof Error ? err.message : 'unknown error'}` },
        }
      }
      return { success: false, error: `Streaming failed: ${err instanceof Error ? err.message : 'unknown error'}` }
    }

    return { success: true, data: { artifactId, blocksInserted, lastBlockId } }
  },
})

// === Flush boundary detection ===
// Returns index of the first flush-worthy boundary in the buffer, or -1 if none found.
// Flush on: double newline (paragraph break), or a line starting with # or ``` (structural boundary)

const findFlushBoundary = (text: string): number => {
  // Double newline — paragraph break
  let idx = text.indexOf('\n\n')
  if (idx !== -1) return idx + 2

  // Heading or code fence at the start of a line (after the first line)
  const firstNewline = text.indexOf('\n')
  if (firstNewline === -1) return -1

  const rest = text.slice(firstNewline + 1)
  const structuralMatch = rest.match(/^(#{1,3} |```)/)
  if (structuralMatch) return firstNewline + 1

  return -1
}
