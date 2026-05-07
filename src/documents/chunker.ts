// ============================================================================
// Chunker — splits extracted plain text into overlapping chunks for
// embedding. Paragraph-aware, with a token budget per chunk and a small
// overlap so passages straddling a boundary still surface in retrieval.
//
// Token estimation uses a 4-char-per-token heuristic — exact tokenisation
// is not required (we're feeding embedders, not max-context-LLMs), and
// avoiding tiktoken keeps the dep tree clean.
// ============================================================================

const CHARS_PER_TOKEN = 4
const DEFAULT_TARGET_TOKENS = 400
const DEFAULT_OVERLAP_TOKENS = 80

export interface Chunk {
  readonly text: string
  readonly chunkIdx: number
  readonly approxTokens: number
}

export interface ChunkOptions {
  readonly targetTokens?: number
  readonly overlapTokens?: number
}

const splitParagraphs = (text: string): string[] => {
  // Split on blank lines, trim, drop empties.
  return text
    .split(/\n\s*\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

export const chunkText = (text: string, opts: ChunkOptions = {}): Chunk[] => {
  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET_TOKENS
  const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS
  const targetChars = targetTokens * CHARS_PER_TOKEN
  const overlapChars = overlapTokens * CHARS_PER_TOKEN

  const paragraphs = splitParagraphs(text)
  if (paragraphs.length === 0) return []

  const chunks: Chunk[] = []
  let buf = ''
  const flush = (): void => {
    const content = buf.trim()
    if (!content) return
    chunks.push({
      text: content,
      chunkIdx: chunks.length,
      approxTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
    })
    // Carry the tail (overlap) into the next chunk so we don't lose
    // semantic boundaries that straddle the cut.
    if (overlapChars > 0 && content.length > overlapChars) {
      buf = content.slice(content.length - overlapChars)
    } else {
      buf = ''
    }
  }

  for (const para of paragraphs) {
    // If adding this paragraph would exceed the budget AND we already have
    // content, flush. (We always include at least one paragraph per chunk
    // even if it's oversized — splitting prose mid-sentence is worse than
    // having one long chunk.)
    if (buf.length > 0 && buf.length + 2 + para.length > targetChars) {
      flush()
    }
    if (buf.length === 0) {
      buf = para
    } else {
      buf += '\n\n' + para
    }
    // If a single paragraph alone blows past 2× target, hard-split it on
    // sentence boundaries to keep chunks tractable.
    while (buf.length > targetChars * 2) {
      const cutAt = findSentenceBoundary(buf, targetChars)
      const head = buf.slice(0, cutAt).trim()
      buf = buf.slice(cutAt).trim()
      if (head) {
        chunks.push({
          text: head,
          chunkIdx: chunks.length,
          approxTokens: Math.ceil(head.length / CHARS_PER_TOKEN),
        })
      }
    }
  }
  flush()
  return chunks
}

// Find the last sentence-ending boundary at or before maxLen. Falls back
// to a hard split if no boundary found.
const findSentenceBoundary = (text: string, maxLen: number): number => {
  const slice = text.slice(0, maxLen)
  const candidates = [...slice.matchAll(/[.!?]\s+/g)]
  if (candidates.length === 0) return maxLen
  const last = candidates[candidates.length - 1]!
  return last.index + last[0].length
}
