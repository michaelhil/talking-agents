// ============================================================================
// Documents — type-only module. Per-instance corpus of uploaded files
// that can be searched via the query_documents tool.
//
// On-disk layout (per instance):
//   instances/<id>/documents/<docId>/original.<ext>     uploaded binary
//   instances/<id>/documents/<docId>/extracted.txt      plain-text extract
//   instances/<id>/documents/<docId>/metadata.json      DocumentMetadata
//   instances/<id>/documents/<docId>/.pending           marker — present
//                                                       between upload and
//                                                       indexer completion;
//                                                       missing = terminal
//                                                       state (indexed or
//                                                       failed)
//
// Vectors live in instances/<id>/vectors.jsonl with namespace='document'
// and metadata { docId, chunkIdx, page? }. Deletion writes tombstones to
// the vector store and removes the documents/<docId>/ directory.
// ============================================================================

export type DocumentStatus = 'pending' | 'indexed' | 'failed'

export interface DocumentMetadata {
  readonly docId: string
  readonly filename: string
  readonly mimetype: string
  readonly sizeBytes: number
  readonly uploadTs: number
  readonly status: DocumentStatus
  readonly errorMessage?: string  // populated when status='failed'
  readonly pageCount?: number     // PDF page count when extraction succeeded
  readonly chunkCount?: number    // populated after successful indexing
}

// Allowed extensions. .docx deferred (would need a different extractor).
export const ALLOWED_EXTENSIONS = ['.pdf', '.md', '.txt'] as const
export type AllowedExtension = typeof ALLOWED_EXTENSIONS[number]

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024  // 25 MB
