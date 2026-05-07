// ============================================================================
// Extractor — pulls plain text from uploaded files.
//
// .pdf → unpdf (modern, zero-deps, ESM, works under Bun)
// .md / .txt → passthrough as utf-8
// .docx and others → unsupported in v1; caller must reject before calling.
// ============================================================================

export interface ExtractResult {
  readonly text: string
  readonly pageCount?: number  // PDF only
}

export class ExtractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractError'
  }
}

const decodeUtf8 = (bytes: Uint8Array): string => {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export const extractFromBytes = async (
  bytes: Uint8Array,
  ext: '.pdf' | '.md' | '.txt',
): Promise<ExtractResult> => {
  if (ext === '.md' || ext === '.txt') {
    return { text: decodeUtf8(bytes) }
  }
  if (ext === '.pdf') {
    try {
      const { extractText, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(bytes)
      const { text, totalPages } = await extractText(pdf, { mergePages: true })
      // unpdf returns either string or string[] depending on mergePages
      const merged = Array.isArray(text) ? text.join('\n\n') : text
      return { text: merged, pageCount: totalPages }
    } catch (err) {
      throw new ExtractError(`PDF extraction failed: ${(err as Error).message}`)
    }
  }
  throw new ExtractError(`unsupported extension: ${ext as string}`)
}
