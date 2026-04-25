// ============================================================================
// Instances admin — list / create / switch / delete the per-tenant Houses.
//
// Surfaces the on-disk + in-memory registry to the UI's Instances modal under
// Settings. Reset of the *current* instance still goes through /api/system/reset
// (existing 10s-countdown UX). Delete here is a one-shot for non-current
// instances and refuses to delete the cookie-bound one — the user must switch
// or reset first.
// ============================================================================

import { json, errorResponse } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { getInstanceId } from '../instance-cookie.ts'

const REQUIRED = (msg = 'instances admin not wired') => errorResponse(msg, 501)

export const instanceRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/instances$/,
    handler: async (req, _match, ctx) => {
      if (!ctx.instances) return REQUIRED()
      const onDisk = await ctx.instances.listOnDisk()
      const live = ctx.instances.liveIds()
      const current = getInstanceId(req)
      const out = onDisk.map(entry => ({
        id: entry.id,
        snapshotMtimeMs: entry.snapshotMtimeMs,
        snapshotSizeBytes: entry.snapshotSizeBytes,
        isLive: live.has(entry.id),
        isCurrent: entry.id === current,
      }))
      // Sort: current first, then live, then by mtime desc.
      out.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
        if (a.isLive !== b.isLive) return a.isLive ? -1 : 1
        return b.snapshotMtimeMs - a.snapshotMtimeMs
      })
      return json({ instances: out, currentId: current })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/instances$/,
    handler: async (_req, _match, ctx) => {
      if (!ctx.instances) return REQUIRED()
      const result = await ctx.instances.createNew()
      return json({ id: result.id }, 201)
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/instances\/([a-z0-9]{16})\/switch$/,
    handler: async (req, match, ctx) => {
      if (!ctx.instances) return REQUIRED()
      const targetId = match[1]!
      // Validate the target exists on disk (or is currently live). Refuses
      // arbitrary ids so a stray switch can't resurrect an empty instance
      // under a guessed id.
      const onDisk = await ctx.instances.listOnDisk()
      const live = ctx.instances.liveIds()
      if (!live.has(targetId) && !onDisk.some(e => e.id === targetId)) {
        return errorResponse(`instance "${targetId}" not found`, 404)
      }
      const setCookie = ctx.instances.buildSwitchCookie(targetId, req)
      return new Response(JSON.stringify({ ok: true, id: targetId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': setCookie },
      })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/instances\/([a-z0-9]{16})$/,
    handler: async (req, match, ctx) => {
      if (!ctx.instances) return REQUIRED()
      const targetId = match[1]!
      const current = getInstanceId(req)
      if (current === targetId) {
        return errorResponse(
          'cannot delete the current instance — switch to another or use /api/system/reset',
          409,
        )
      }
      const result = await ctx.instances.delete(targetId)
      if (!result.ok) return errorResponse(result.reason, 400)
      return json({ deleted: true, id: targetId })
    },
  },
]
