// ============================================================================
// /api/documents — per-instance document corpus for RAG.
//
// GET    /api/documents          → list all documents in this instance
// POST   /api/documents          → upload (multipart/form-data, field "file")
// DELETE /api/documents/:docId   → remove the doc + tombstone its vectors
//
// Auth: gated by the instance cookie like every other per-instance route.
// Rate limit: per-IP. Default 10 uploads / hour, tunable via env vars.
// ============================================================================

import type { LimitMetrics } from '../../core/limit-metrics.ts'
import { createRateLimiter, type RateLimiter } from '../rate-limit.ts'
import { errorResponse, json } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { MAX_UPLOAD_BYTES } from '../../documents/types.ts'

let uploadLimiter: RateLimiter | null = null
export const initDocumentsLimiter = (limitMetrics?: LimitMetrics): RateLimiter => {
  if (uploadLimiter) return uploadLimiter
  uploadLimiter = createRateLimiter({
    windowMs: Number(process.env.SAMSINN_DOC_UPLOAD_WINDOW_MS) || 3_600_000,  // 1h
    max: Number(process.env.SAMSINN_DOC_UPLOAD_LIMIT) || 10,
    ...(limitMetrics ? { limitMetrics } : {}),
  })
  return uploadLimiter
}
const getUploadLimiter = (): RateLimiter => initDocumentsLimiter()

const NOT_AVAILABLE = (): Response =>
  errorResponse('document corpus is not available on this instance (no embedder configured)', 503)

export const documentRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/documents$/,
    handler: (_req, _match, { system }) => {
      if (!system.documents) return NOT_AVAILABLE()
      return json({ documents: system.documents.list() })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/documents$/,
    handler: async (req, _match, { system, remoteAddress }) => {
      if (!system.documents) return NOT_AVAILABLE()

      const limiter = getUploadLimiter()
      const limit = limiter.check(remoteAddress)
      if (!limit.ok) {
        return new Response(
          JSON.stringify({ error: 'upload rate limit exceeded' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)),
            },
          },
        )
      }

      const contentType = req.headers.get('content-type') ?? ''
      if (!contentType.startsWith('multipart/form-data')) {
        return errorResponse('expected multipart/form-data with field "file"', 400)
      }

      let form: Awaited<ReturnType<Request['formData']>>
      try {
        form = await req.formData()
      } catch (err) {
        return errorResponse(`could not parse multipart body: ${(err as Error).message}`, 400)
      }
      const file = form.get('file')
      // Bun returns a File for binary form fields; the env-types union widens
      // to FormDataEntryValue but at runtime we only care about File-shaped.
      if (!file || typeof file === 'string') {
        return errorResponse('missing form field "file"', 400)
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return errorResponse(`file exceeds ${MAX_UPLOAD_BYTES} byte limit`, 413)
      }

      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const meta = await system.documents.upload(file.name, bytes, file.type || 'application/octet-stream')
        return json({ document: meta })
      } catch (err) {
        return errorResponse((err as Error).message, 400)
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/documents\/([^/]+)$/,
    handler: async (_req, match, { system }) => {
      if (!system.documents) return NOT_AVAILABLE()
      const docId = decodeURIComponent(match[1]!)
      const removed = await system.documents.remove(docId)
      if (!removed) return errorResponse(`document '${docId}' not found`, 404)
      return json({ ok: true, docId })
    },
  },
]
